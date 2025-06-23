import numpy as np
import scipy.io.wavfile as wav
import scipy.signal as signal

# Read the original audio file
sr, data = wav.read('output.wav')
data = data.astype(np.float32) / 32768.0

# Analyze first 10 seconds for beep detection
window_size = int(0.1 * sr)  # 100ms windows
threshold = 0.1

print(f"Analyzing audio file: {len(data)/sr:.2f}s duration")
print(f"Sample rate: {sr}Hz")
print(f"Window size: {window_size} samples ({window_size/sr:.3f}s)")

# Look for beep in first 10 seconds
for i in range(0, min(len(data) - window_size, int(10 * sr)), window_size):
    window = data[i:i+window_size]
    rms = np.sqrt(np.mean(window**2))
    if rms > threshold:
        print(f"Beep detected at {i/sr:.3f}s (RMS: {rms:.3f})")
        break
else:
    print("No beep detected in first 10 seconds") 