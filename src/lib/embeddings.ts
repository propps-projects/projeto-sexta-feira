import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

// Multilingual E5 — strong for pt-BR retrieval, 384 dims, ~120MB.
// E5 family requires "query: " / "passage: " prefixes for best results.
const MODEL_ID = "Xenova/multilingual-e5-small";
export const EMBED_DIM = 384;

let pipe: FeatureExtractionPipeline | null = null;

async function getPipe(): Promise<FeatureExtractionPipeline> {
  if (pipe) return pipe;
  pipe = await pipeline("feature-extraction", MODEL_ID, { dtype: "fp32" });
  return pipe;
}

async function embed(texts: string[]): Promise<Float32Array[]> {
  const p = await getPipe();
  const output = await p(texts, { pooling: "mean", normalize: true });
  // output.data is a flat Float32Array of length texts.length * EMBED_DIM
  const flat = output.data as Float32Array;
  return texts.map((_, i) => flat.slice(i * EMBED_DIM, (i + 1) * EMBED_DIM));
}

export async function embedQuery(text: string): Promise<Float32Array> {
  const [v] = await embed([`query: ${text}`]);
  return v;
}

export async function embedPassages(texts: string[]): Promise<Float32Array[]> {
  return embed(texts.map((t) => `passage: ${t}`));
}
