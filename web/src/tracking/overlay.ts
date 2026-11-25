// Erkannte Punkte ueber dem Kamerabild zeichnen.
import { DrawingUtils, HandLandmarker, type NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision';

export class Overlay {
  private readonly drawer: DrawingUtils;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.drawer = new DrawingUtils(canvas.getContext('2d')!);
  }

  draw(landmarks: NormalizedLandmark[] | null, hands: NormalizedLandmark[][] = []): void {
    const { video, canvas } = this;
    if (canvas.width !== video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
    if (!landmarks) return;
    this.drawer.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, { color: '#6cc4a1', lineWidth: 3 });
    this.drawer.drawLandmarks(landmarks, { color: '#e5625e', radius: 3 });
    for (const hand of hands) {
      this.drawer.drawConnectors(hand, HandLandmarker.HAND_CONNECTIONS, { color: '#f2c14e', lineWidth: 2 });
    }
  }
}
