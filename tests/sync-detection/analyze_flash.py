import cv2
import numpy as np

# Open the video file
cap = cv2.VideoCapture('output.mp4')

if not cap.isOpened():
    print("Error: Could not open video file")
    exit()

fps = cap.get(cv2.CAP_PROP_FPS)
total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

start_frame = int(4 * fps)
end_frame = int(8 * fps)

cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

brightness_values = []
max_delta = 0
max_delta_frame = start_frame

for i in range(start_frame, end_frame):
    ret, frame = cap.read()
    if not ret:
        break
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    brightness = np.mean(gray)
    brightness_values.append(brightness)
    print(f"Frame {i} ({i/fps:.3f}s): brightness={brightness:.1f}")
    if len(brightness_values) > 1:
        delta = abs(brightness_values[-1] - brightness_values[-2])
        if delta > max_delta:
            max_delta = delta
            max_delta_frame = i

cap.release()

print(f"Max brightness delta: {max_delta:.1f} at frame {max_delta_frame} ({max_delta_frame/fps:.3f}s)") 