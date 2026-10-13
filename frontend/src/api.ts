export type Model = { tier: string; name: string }
export type Chat = { id: string; title: string; created_at: number }
export type Message = { id: string; role: 'user' | 'assistant'; content: string; model: string | null; created_at: number }
export type ChatDetail = { chat: Chat; messages: Message[] }
export type ApiKey = { id: string; label: string; prefix: string; created_at: number; last_used_at: number | null }

const API_URL = (import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '')
let sessionToken = sessionStorage.getItem('threeapes_demo_session') || ''
export function setSessionToken(token: string) {
  sessionToken = token
  if (token) sessionStorage.setItem('threeapes_demo_session', token)
  else sessionStorage.removeItem('threeapes_demo_session')
}
export function hasSession() { return Boolean(sessionToken) }

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      ...init.headers,
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || `Request failed (${res.status})`)
  }
  return res.json() as Promise<T>
}

export async function streamMessage(
  chatId: string,
  content: string,
  tier: string,
  onEvent: (event: string, data: any) => void,
): Promise<void> {
  const res = await fetch(`${API_URL}/api/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ content, tier }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(data.error || `Inference failed (${res.status})`)
  }
  if (!res.body) throw new Error('Streaming is unavailable in this browser')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let terminal = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const event = frame.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message'
        const raw = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
        if (!raw) continue
        const data = JSON.parse(raw)
        onEvent(event, data)
        if (event === 'done') terminal = true
        if (event === 'error') throw new Error(data.error || 'Inference stream error')
      }
    }
    if (!terminal) throw new Error('Inference stream ended before completion')
  } finally {
    reader.releaseLock()
  }
}
