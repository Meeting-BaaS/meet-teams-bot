use anyhow::Result;
use clap::Parser;
use image;
use pipewire::{
    context::Context,
    main_loop::MainLoop,
    properties,
    spa::utils::{Direction, Fraction, Rectangle},
    stream::{Stream, StreamFlags},
};
use std::time::Instant;

// Custom Builder implementation
use std::{
    ffi::{c_int, c_void, CString},
    mem::MaybeUninit,
};

use nix::errno::Errno;

use pipewire::spa::utils::{Fraction as SpaFraction, Id, Rectangle as SpaRectangle};

static CALLBACKS: libspa_sys::spa_pod_builder_callbacks = libspa_sys::spa_pod_builder_callbacks {
    version: libspa_sys::SPA_VERSION_POD_BUILDER_CALLBACKS,
    overflow: Some(Builder::overflow),
};

struct BuilderInner<'d> {
    builder: libspa_sys::spa_pod_builder,
    data: &'d mut Vec<u8>,
}

pub struct Builder<'d> {
    // Keep the actual state in a box, so that
    // we can be sure that it does not move while the builder is in use
    // This lets us access it via pointer in the overflow callback
    inner: Box<BuilderInner<'d>>,
}

impl<'d> Builder<'d> {
    unsafe extern "C" fn overflow(data: *mut c_void, size: u32) -> c_int {
        let this: *mut BuilderInner = data.cast();

        assert!(!this.is_null());
        assert!(size as usize > (*this).data.len());

        // Resize the vec to be `size` longer, so that the new value fits,
        // then update the builders internal data size and also the data pointer
        // in case the vec had to reallocate
        (*this).data.resize(size as usize, 0);
        (*this).builder.data = (*this).data.as_mut_ptr().cast::<c_void>();
        (*this).builder.size = (*this)
            .data
            .len()
            .try_into()
            .expect("data length does not fit in a u32");

        // Return zero to indicate that we successfully resized our data
        0
    }

    pub fn new(data: &'d mut Vec<u8>) -> Self {
        unsafe {
            let mut builder: MaybeUninit<libspa_sys::spa_pod_builder> = MaybeUninit::uninit();

            libspa_sys::spa_pod_builder_init(
                builder.as_mut_ptr(),
                data.as_mut_ptr().cast(),
                data.len()
                    .try_into()
                    .expect("data length does not fit in a u32"),
            );

            let inner = Box::new(BuilderInner {
                builder: builder.assume_init(),
                data,
            });

            libspa_sys::spa_pod_builder_set_callbacks(
                std::ptr::addr_of!(inner.builder).cast_mut(),
                std::ptr::addr_of!(CALLBACKS),
                std::ptr::addr_of!(*inner).cast::<c_void>().cast_mut(),
            );

            Self { inner }
        }
    }

    pub fn as_raw(&self) -> &libspa_sys::spa_pod_builder {
        &self.inner.builder
    }

    pub fn as_raw_ptr(&self) -> *mut libspa_sys::spa_pod_builder {
        std::ptr::addr_of!(self.inner.builder).cast_mut()
    }

    pub fn add_id(&mut self, val: Id) -> Result<(), Errno> {
        unsafe {
            let res = libspa_sys::spa_pod_builder_id(self.as_raw_ptr(), val.0);

            if res >= 0 {
                Ok(())
            } else {
                Err(Errno::from_i32(-res))
            }
        }
    }

    pub fn add_rectangle(&mut self, val: SpaRectangle) -> Result<(), Errno> {
        unsafe {
            let res =
                libspa_sys::spa_pod_builder_rectangle(self.as_raw_ptr(), val.width, val.height);

            if res >= 0 {
                Ok(())
            } else {
                Err(Errno::from_i32(-res))
            }
        }
    }

    pub fn add_fraction(&mut self, val: SpaFraction) -> Result<(), Errno> {
        unsafe {
            let res = libspa_sys::spa_pod_builder_fraction(self.as_raw_ptr(), val.num, val.denom);

            if res >= 0 {
                Ok(())
            } else {
                Err(Errno::from_i32(-res))
            }
        }
    }

    pub fn add_prop(&mut self, key: u32, flags: u32) -> Result<(), Errno> {
        let res = unsafe { libspa_sys::spa_pod_builder_prop(self.as_raw_ptr(), key, flags) };

        if res >= 0 {
            Ok(())
        } else {
            Err(Errno::from_i32(-res))
        }
    }

    pub unsafe fn push_object(
        &mut self,
        frame: &mut MaybeUninit<libspa_sys::spa_pod_frame>,
        type_: u32,
        id: u32,
    ) -> Result<(), Errno> {
        unsafe {
            let res = libspa_sys::spa_pod_builder_push_object(
                self.as_raw_ptr(),
                frame.as_mut_ptr(),
                type_,
                id,
            );

            if res >= 0 {
                Ok(())
            } else {
                Err(Errno::from_i32(-res))
            }
        }
    }

    pub unsafe fn pop(&mut self, frame: &mut libspa_sys::spa_pod_frame) {
        unsafe {
            libspa_sys::spa_pod_builder_pop(self.as_raw_ptr(), frame as *mut _);
        }
    }
}

/// Convenience macro to build a pod from values using a spa pod builder.
#[macro_export]
macro_rules! __builder_add__ {
    ($builder:expr, Id($val:expr)) => {
        $crate::Builder::add_id($builder, $val)
    };
    ($builder:expr, Rectangle($val:expr)) => {
        $crate::Builder::add_rectangle($builder, $val)
    };
    ($builder:expr, Fraction($val:expr)) => {
        $crate::Builder::add_fraction($builder, $val)
    };
    (
        $builder:expr,
        Object($type_:expr, $id:expr $(,)?) {
            $( $key:expr => $value_type:tt $value:tt ),* $(,)?
        }
    ) => {
        'outer: {
            let mut frame: ::std::mem::MaybeUninit<libspa_sys::spa_pod_frame> = ::std::mem::MaybeUninit::uninit();
            let res = unsafe { $crate::Builder::push_object($builder, &mut frame, $type_, $id) };
            if res.is_err() {
                break 'outer res;
            }

            $(
                let res = $crate::Builder::add_prop($builder, $key, 0);
                if res.is_err() {
                    break 'outer res;
                }
                let res = $crate::__builder_add__!($builder, $value_type $value);
                if res.is_err() {
                    break 'outer res;
                }
            )*

            unsafe { $crate::Builder::pop($builder, frame.assume_init_mut()) }

            Ok(())
        }
    };
}
pub use __builder_add__ as builder_add;

#[derive(Parser)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Path to the image file to stream
    image_path: String,
}

fn main() -> Result<()> {
    let args = Args::parse();
    println!("Starting Rust Virtual Camera to stream an image...");
    println!("Loading image from: \"{}\"", args.image_path);

    // Load the image
    let img = image::open(&args.image_path)?;
    let img = img.to_rgba8();
    println!(
        "Image loaded successfully ({}x{})",
        img.width(),
        img.height()
    );

    // Convert to BGRA format (PipeWire expects BGRA)
    let bgra_data: Vec<u8> = img
        .pixels()
        .flat_map(|pixel| {
            // Convert RGBA to BGRA
            vec![pixel[2], pixel[1], pixel[0], pixel[3]] // B, G, R, A
        })
        .collect();

    let bgra_data_clone = bgra_data.clone();

    // Initialize PipeWire
    pipewire::init();

    // Create main loop
    let main_loop = MainLoop::new(None)?;
    let context = Context::new(&main_loop)?;
    let core = context.connect(None)?;

    // Create stream properties
    let props = properties::properties! {
            *pipewire::keys::MEDIA_TYPE => "Video",
            *pipewire::keys::MEDIA_CATEGORY => "Capture",
            *pipewire::keys::MEDIA_ROLE => "Camera",
        *pipewire::keys::MEDIA_CLASS => "Video/Source",
        *pipewire::keys::DEVICE_NAME => "Rust Virtual Camera",
        *pipewire::keys::DEVICE_DESCRIPTION => "Rust Virtual Camera",
        *pipewire::keys::DEVICE_ICON_NAME => "camera-web",
        *pipewire::keys::NODE_NAME => "rust-image-camera",
        *pipewire::keys::NODE_DESCRIPTION => "Rust Virtual Camera",
        *pipewire::keys::FACTORY_NAME => "spa-node-factory",
        "stream.is-live" => "true",
        "node.want-driver" => "true",
        "node.autoconnect" => "true",
    };

    // Create stream
    let stream = Stream::new(&core, "rust-image-camera", props)?;

    // Add stream listener
    let _listener = stream
        .add_local_listener::<()>()
        .state_changed(move |_old, _new, _id, _data| {
            println!("Stream state changed");
        })
        .param_changed(move |stream, id, param, _data| {
            let start_time = Instant::now();
            println!(
                "Parameter changed: id={:?}, param={:?} at {:?}",
                id, param, start_time
            );

            // Log all parameters for debugging
            println!("DEBUG: Received parameter {} (0x{:x})", param, param);

            // Handle EnumFormat parameter (appears to be param 15 in this context)
            if param == 15 {
                println!(
                    "Received SPA_PARAM_EnumFormat (15) - responding with our format at {:?}",
                    start_time
                );

                // Build the format pod using our custom Builder
                let mut data = Vec::with_capacity(512);
                let mut builder = Builder::new(&mut data);

                // Use the builder_add! macro to build the format pod
                let res = builder_add!(
                    &mut builder,
                    Object(
                        262147, // SPA_TYPE_OBJECT_Format
                        3,      // SPA_PARAM_EnumFormat
                    ) {
                        1 => Id(Id(2)),                    // mediaType: SPA_MEDIA_TYPE_video
                        2 => Id(Id(1)),                    // mediaSubtype: SPA_MEDIA_SUBTYPE_raw
                        131073 => Id(Id(12)),              // format: SPA_VIDEO_FORMAT_BGRA
                        131075 => Rectangle(SpaRectangle { width: 640, height: 480 }),
                        131076 => Fraction(SpaFraction { num: 30, denom: 1 }),
                    }
                );

                if let Err(e) = res {
                    println!("Failed to build format pod: {:?}", e);
                    return;
                }

                println!(
                    "DEBUG: Built format pod for param 15, size: {} bytes",
                    data.len()
                );

                // Create a Pod from the data buffer
                let pod = pipewire::spa::pod::Pod::from_bytes(&data).unwrap();
                let mut params = vec![pod];

                // Use update_params to send the format pod
                let update_result = stream.update_params(&mut params);
                if let Err(e) = update_result {
                    println!("Failed to update params: {:?}", e);
                    return;
                }

                println!(
                    "Successfully responded to format negotiation for param 15 at {:?}!",
                    start_time
                );
            }
            // Also handle the original param 3 case
            else if param == 3 {
                println!(
                    "Received SPA_PARAM_EnumFormat (3) - format already advertised upfront at {:?}",
                    start_time
                );
            }
            // Handle Format parameter (4)
            else if param == 4 {
                println!(
                    "Received param {} (Format) - letting PipeWire handle it at {:?}",
                    param, start_time
                );
                let result = stream.update_params(&mut []);
                if let Err(e) = result {
                    println!("Failed to update params: {:?}", e);
                }
            }
            // Handle Buffers parameter (7) - this is crucial for buffer setup
            else if param == 7 {
                println!(
                    "Received param {} (Buffers) - responding with buffer configuration at {:?}",
                    param, start_time
                );

                // Build buffer configuration pod
                let mut data = Vec::with_capacity(512);
                let mut builder = Builder::new(&mut data);

                // Buffer configuration: 640x480 BGRA = 1,228,800 bytes per frame
                let res = builder_add!(
                    &mut builder,
                    Object(
                        262147, // SPA_TYPE_OBJECT_ParamBuffers
                        7,      // SPA_PARAM_Buffers
                    ) {
                        1 => Id(Id(1)),                    // buffers: 1 buffer
                        2 => Id(Id(1228800)),              // blocks: 1,228,800 bytes per frame
                        3 => Id(Id(1228800)),              // size: 1,228,800 bytes per frame
                        4 => Id(Id(30)),                   // stride: 30 fps
                        5 => Id(Id(0)),                    // align: no special alignment
                    }
                );

                if let Err(e) = res {
                    println!("Failed to build buffer pod: {:?}", e);
                    return;
                }

                println!("DEBUG: Built buffer pod, size: {} bytes", data.len());

                // Create a Pod from the data buffer
                let pod = pipewire::spa::pod::Pod::from_bytes(&data).unwrap();
                let mut params = vec![pod];

                // Send the buffer configuration
                let result = stream.update_params(&mut params);
                if let Err(e) = result {
                    println!("Failed to update buffer params: {:?}", e);
                } else {
                    println!("Successfully sent buffer configuration!");
                }
            }
            // For any other parameter, just log it
            else {
                println!("DEBUG: Unhandled parameter {} - not responding", param);
            }
        })
        .add_buffer(move |_stream, _buffer, _data| {
            // Handle buffer allocation
            println!("Buffer added to stream at {:?}", Instant::now());
        })
        .remove_buffer(move |_stream, _buffer, _data| {
            // Handle buffer removal
            println!("Buffer removed from stream at {:?}", Instant::now());
        })
        .process(move |stream, _data| {
            let start_time = Instant::now();
            if let Some(mut buffer) = stream.dequeue_buffer() {
                println!(
                    "DEBUG: Got buffer, datas count: {}",
                    buffer.datas_mut().len()
                );
                if let Some(data) = buffer.datas_mut().get_mut(0) {
                    let chunk_size = data.chunk().size() as usize;
                    println!(
                        "DEBUG: Chunk size: {}, bgra_data_clone len: {}",
                        chunk_size,
                        bgra_data_clone.len()
                    );
                    if let Some(buffer_slice) = data.data() {
                        println!("DEBUG: Buffer slice len: {}", buffer_slice.len());
                        // Copy our image data into the buffer
                        let copy_size = std::cmp::min(chunk_size, bgra_data_clone.len());
                        buffer_slice[..copy_size].copy_from_slice(&bgra_data_clone[..copy_size]);

                        println!(
                            "Processed frame at {:?}, copied {} bytes",
                            start_time, copy_size
                        );
                    } else {
                        println!("DEBUG: No buffer slice available");
                    }
                } else {
                    println!("DEBUG: No data available in buffer");
                }
                // Note: The buffer is automatically queued when the process callback returns
            } else {
                println!("DEBUG: No buffer available for dequeuing");
            }
        })
        .register();

    // Build the format pod upfront to advertise our supported format
    let mut data = Vec::with_capacity(512);
    let mut builder = Builder::new(&mut data);

    // Use the builder_add! macro to build the format pod
    // Format type is 262147 (SPA_TYPE_OBJECT_Format), EnumFormat ID is 3
    let res = builder_add!(
        &mut builder,
        Object(
            262147, // SPA_TYPE_OBJECT_Format
            3,      // SPA_PARAM_EnumFormat
        ) {
            1 => Id(Id(2)),                    // mediaType: SPA_MEDIA_TYPE_video
            2 => Id(Id(1)),                    // mediaSubtype: SPA_MEDIA_SUBTYPE_raw
            131073 => Id(Id(12)),              // format: SPA_VIDEO_FORMAT_BGRA
            131075 => Rectangle(SpaRectangle { width: 640, height: 480 }),
            131076 => Fraction(SpaFraction { num: 30, denom: 1 }),
        }
    );

    if let Err(e) = res {
        println!("Failed to build format pod: {:?}", e);
        return Err(anyhow::anyhow!("Failed to build format pod: {:?}", e));
    }

    println!(
        "DEBUG: Built initial format pod, size: {} bytes",
        data.len()
    );

    // Create a Pod from the data buffer
    let pod = pipewire::spa::pod::Pod::from_bytes(&data).unwrap();
    let mut params = vec![pod];

    // Connect the stream with our format pod advertised upfront
    stream.connect(
        Direction::Output,
        None,
        StreamFlags::AUTOCONNECT, // Remove INACTIVE to allow auto-activation
        &mut params,
    )?;

    // Set the stream as active to start format negotiation
    stream.set_active(true)?;

    println!("Virtual camera 'rust-image-camera' is running.");
    println!("Open a browser or video application and select it as your camera.");
    println!("Press Ctrl+C to stop.");

    // Run the main loop
    main_loop.run();

    Ok(())
}
