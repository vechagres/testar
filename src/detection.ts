import * as mobilenet from '@tensorflow-models/mobilenet';
import '@tensorflow/tfjs';

export type DetectionResult = {
  label: string;
  probability: number;
};

let model: mobilenet.MobileNet | null = null;

export async function ensureModelLoaded(): Promise<void> {
  if (!model) {
    model = await mobilenet.load({ version: 2, alpha: 0.5 });
  }
}

export async function classifyImage(img: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement, topK = 5): Promise<DetectionResult[]> {
  if (!model) await ensureModelLoaded();
  const preds = await model!.classify(img as any, topK);
  return preds.map(p => ({ label: p.className, probability: p.probability }));
}

export function isDjembeLabel(label: string): boolean {
  const l = label.toLowerCase();
  // Heuristics: 'djembe', 'drum', 'goblet drum'
  return l.includes('djembe') || l.includes('goblet') || (l.includes('drum') && (l.includes('hand') || l.includes('african') || l.includes('percussion')));
}