"""Quick scale sweep: find at what image scale the model detects the card."""
import sys
from PIL import Image
from ultralytics import YOLO

HERE = __import__("pathlib").Path(__file__).resolve().parent
MODEL = HERE.parent / "train" / "runs" / "uno_flip-6" / "weights" / "best.pt"
PHOTO = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\bangj\Desktop\unoflip.jpg"

m = YOLO(str(MODEL))
src = Image.open(PHOTO).convert("RGB")
W, H = src.size
print("source", W, H)

for s in (0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0):
    w, h = round(W * s), round(H * s)
    nw = ((w + 31) // 32) * 32  # pad width to a stride-32 multiple, like LetterBox
    canvas = Image.new("RGB", (nw, h), (114, 114, 114))
    canvas.paste(src.resize((w, h)), ((nw - w) // 2, 0))
    results = m.predict(canvas, conf=0.001, imgsz=(nw, h), verbose=False)
    tops = [(m.names[int(b.cls[0])], round(float(b.conf[0]), 3))
            for res in results for b in res.boxes]
    tops.sort(key=lambda t: -t[1])
    print(f"  scale {s:.2f}  input {nw}x{h}  top={tops[:3]}")
