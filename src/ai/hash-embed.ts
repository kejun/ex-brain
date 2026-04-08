import type { EmbeddingConfig, EmbeddingFunction } from "seekdb";

const DIM = 384;

function hashToVector(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (let i = 0; i < text.length; i += 1) {
    const j = i % DIM;
    v[j] = (v[j]! + text.charCodeAt(i) * (i + 1)) / 1e6;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/**
 * 零依赖、确定性的伪向量，满足 seekdb 集合对「文档 → 向量」的硬性要求；
 * 不替代真实语义模型，仅用于嵌入模式本地可跑通全文 + 近似检索管线。
 */
export class LocalHashEmbeddingFunction implements EmbeddingFunction {
  readonly name = "ebrain-local-hash";
  readonly dimension = DIM;

  async generate(texts: string[]): Promise<number[][]> {
    return texts.map((t) => hashToVector(t));
  }

  getConfig(): EmbeddingConfig {
    return { dimension: DIM };
  }
}
