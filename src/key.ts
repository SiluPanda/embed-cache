import { createHash } from 'crypto'
import { normalizeText, canonicalizeModel } from './normalize'

export function computeKey(
  text: string,
  model: string,
  algorithm: 'sha256' | 'sha1' | 'md5',
  normalize: boolean
): string {
  const normalizedText = normalize ? normalizeText(text) : text
  const canonicalModel = canonicalizeModel(model)
  const input = `${normalizedText}\x00${canonicalModel}`
  return createHash(algorithm).update(input, 'utf8').digest('hex')
}
