// Kamera oder Videodatei in einem Videoelement abspielen.

export function stopVideo(video: HTMLVideoElement): void {
  (video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
}

/** Kameras des Rechners (ein iPhone erscheint am Mac ueber Continuity Camera automatisch). */
export async function listVideoInputs(): Promise<MediaDeviceInfo[]> {
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
}

export const deviceIdOf = (video: HTMLVideoElement): string | undefined =>
  (video.srcObject as MediaStream | null)?.getVideoTracks()[0]?.getSettings().deviceId;

/** Kamera mit 1280x720 oeffnen; ohne deviceId die Standardkamera. */
export async function openCamera(video: HTMLVideoElement, deviceId?: string): Promise<MediaStream> {
  stopVideo(video);
  const constraints: MediaTrackConstraints = { width: 1280, height: 720 };
  if (deviceId) constraints.deviceId = { exact: deviceId };
  const stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
  video.removeAttribute('src');
  video.srcObject = stream;
  await video.play();
  return stream;
}

/** Videodatei (oder URL) in Schleife abspielen, z. B. zum Testen ohne Kamera. */
export async function openFile(video: HTMLVideoElement, url: string): Promise<void> {
  stopVideo(video);
  video.srcObject = null;
  video.src = url;
  await video.play();
}
