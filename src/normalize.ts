export function normalizeText(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/g, ' ')
}

export function canonicalizeModel(model: string): string {
  const KNOWN: Record<string, string> = {
    'text-embedding-3-small': 'openai/text-embedding-3-small',
    'text-embedding-3-large': 'openai/text-embedding-3-large',
    'text-embedding-ada-002': 'openai/text-embedding-ada-002',
    'embed-english-v3.0': 'cohere/embed-english-v3.0',
    'embed-multilingual-v3.0': 'cohere/embed-multilingual-v3.0',
  }
  return KNOWN[model] ?? model.toLowerCase()
}
