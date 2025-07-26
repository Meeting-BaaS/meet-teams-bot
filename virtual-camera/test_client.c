#include <stdio.h>
#include <unistd.h>
#include <signal.h>
#include <spa/utils/result.h>
#include <spa/param/video/format-utils.h>
#include <pipewire/pipewire.h>

#define WIDTH   640
#define HEIGHT  480

struct data {
        struct pw_main_loop *loop;
        struct pw_stream *stream;
        struct spa_hook stream_listener;
};

static void on_process(void *_data)
{
        struct data *data = _data;
        struct pw_stream *stream = data->stream;
        struct pw_buffer *b;

        while ((b = pw_stream_dequeue_buffer(stream)) != NULL) {
                // Just consume the buffer to activate the camera
                printf("Received frame from virtual camera\n");
                pw_stream_queue_buffer(stream, b);
        }
}

static void on_stream_state_changed(void *_data, enum pw_stream_state old,
                                    enum pw_stream_state state, const char *error)
{
        struct data *data = _data;
        printf("stream state: \"%s\"\n", pw_stream_state_as_string(state));
        switch (state) {
        case PW_STREAM_STATE_UNCONNECTED:
                pw_main_loop_quit(data->loop);
                break;
        case PW_STREAM_STATE_PAUSED:
                pw_stream_set_active(data->stream, true);
                break;
        default:
                break;
        }
}

static const struct pw_stream_events stream_events = {
        PW_VERSION_STREAM_EVENTS,
        .state_changed = on_stream_state_changed,
        .process = on_process,
};

static void do_quit(void *userdata, int signal_number)
{
        struct data *data = userdata;
        pw_main_loop_quit(data->loop);
}

int main(int argc, char *argv[])
{
        struct data data = { 0, };
        uint8_t buffer[1024];
        struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
        const struct spa_pod *params[1];
        struct pw_properties *props;
        int res;

        pw_init(&argc, &argv);

        data.loop = pw_main_loop_new(NULL);
        pw_loop_add_signal(pw_main_loop_get_loop(data.loop), SIGINT, do_quit, &data);
        pw_loop_add_signal(pw_main_loop_get_loop(data.loop), SIGTERM, do_quit, &data);

        props = pw_properties_new(PW_KEY_MEDIA_TYPE, "Video",
                        PW_KEY_MEDIA_CATEGORY, "Capture",
                        PW_KEY_MEDIA_ROLE, "Camera",
                        NULL);

        data.stream = pw_stream_new_simple(
                        pw_main_loop_get_loop(data.loop),
                        "test-client",
                        props,
                        &stream_events,
                        &data);

        params[0] = spa_pod_builder_add_object(&b,
                SPA_TYPE_OBJECT_Format, SPA_PARAM_EnumFormat,
                SPA_FORMAT_mediaType,           SPA_POD_Id(SPA_MEDIA_TYPE_video),
                SPA_FORMAT_mediaSubtype,        SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw),
                SPA_FORMAT_VIDEO_format,        SPA_POD_Id(SPA_VIDEO_FORMAT_BGRA),
                SPA_FORMAT_VIDEO_size,          SPA_POD_Rectangle(&SPA_RECTANGLE(WIDTH, HEIGHT)),
                SPA_FORMAT_VIDEO_framerate,     SPA_POD_Fraction(&SPA_FRACTION(30, 1)));

        printf("Connecting to virtual camera...\n");
        if ((res = pw_stream_connect(data.stream,
                          PW_DIRECTION_INPUT,
                          PW_ID_ANY,
                          PW_STREAM_FLAG_AUTOCONNECT,
                          params, 1)) < 0) {
                printf("can't connect: %s (%d)\n", spa_strerror(res), res);
                return -1;
        }

        pw_main_loop_run(data.loop);

        pw_stream_destroy(data.stream);
        pw_main_loop_destroy(data.loop);
        pw_deinit();

        return 0;
} 