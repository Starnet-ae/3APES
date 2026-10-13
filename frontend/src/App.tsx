import { FormEvent, KeyboardEvent, useEffect, useState } from 'react'
import { api, setSessionToken, hasSession, streamMessage, type ApiKey, type Chat, type ChatDetail, type Message, type Model } from './api'

type View = 'router' | 'api'

function Logo() {
  return <div className="brand-lockup"><div className="logo-mark"><span/><span/><span/></div><div><div className="brand-name">3apes</div><div className="brand-subtitle">Confidential AI Router</div></div></div>
}
function TrustStatus() {
  return <div className="trust-warning" title="HTTPS is not remote attestation. This MVP does not yet verify TDX quotes or model attestations.">Attestation not verified</div>
}
function AuthScreen({ onLogin }: { onLogin: (email: string) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [register, setRegister] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      if (register) {
        await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) })
      }
      const session = await api<{ token: string; email: string }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
      setSessionToken(session.token)
      onLogin(session.email)
    } catch (e) { setError(e instanceof Error ? e.message : 'Login failed') }
    finally { setBusy(false) }
  }
  return <div className="auth-background"><div className="auth-card"><Logo/><div className="eyebrow" style={{marginTop:30}}>MVP ACCESS</div><h1>{register ? 'Create an account' : 'Sign in to 3apes'}</h1><p>Access your chats and available confidential model endpoints.</p>
    <form onSubmit={submit} className="auth-form">
      <label>Email<input type="email" required autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)}/></label>
      <label>Password<input type="password" minLength={register ? 12 : undefined} required autoComplete={register?'new-password':'current-password'} value={password} onChange={e=>setPassword(e.target.value)}/></label>
      {error && <div className="error-text" role="alert">{error}</div>}
      <button className="primary-button" disabled={busy}>{busy ? 'Working…' : register ? 'Create account' : 'Sign in'}</button>
    </form>
    <button className="text-action" onClick={()=>{setRegister(!register);setError('')}}>{register ? 'Already registered? Sign in' : 'Need an invite? Create an account if registration is enabled'}</button>
    <div className="security-footnote">Account creation can be disabled in the TEE settings. Attestation has not been verified by this frontend.</div>
  </div></div>
}

function RouterView() {
  const [chats, setChats] = useState<Chat[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [messages, setMessages] = useState<Message[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [tier, setTier] = useState('auto')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [lastModel, setLastModel] = useState('None yet')

  useEffect(() => {
    void Promise.all([api<Chat[]>('/api/chats'), api<{models:Model[]}>('/api/models')]).then(([list,m]) => {
      setChats(list); setModels(m.models)
    }).catch(e => setError(e.message))
  }, [])
  async function openChat(chatId: string) {
    if (busy) return
    setError('')
    try {
      const detail = await api<ChatDetail>(`/api/chats/${encodeURIComponent(chatId)}`)
      setActiveId(chatId); setMessages(detail.messages)
      const prevModel = [...detail.messages].reverse().find(m=>m.model)?.model
      if (prevModel) setLastModel(prevModel)
    } catch(e) { setError(e instanceof Error ? e.message : 'Unable to open chat') }
  }
  function freshChat() { if (!busy) {setActiveId('');setMessages([]);setError('')} }
  async function removeChat(chatId: string) {
    if (busy || !window.confirm('Delete this conversation?')) return
    try {
      await api(`/api/chats/${encodeURIComponent(chatId)}`, {method:'DELETE'})
      setChats(old=>old.filter(x=>x.id!==chatId))
      if (activeId===chatId) freshChat()
    } catch(e) { setError(e instanceof Error ? e.message : 'Unable to delete chat') }
  }
  async function send(e: FormEvent) {
    e.preventDefault()
    if (busy || !prompt.trim()) return
    const content = prompt.trim()
    setBusy(true);setError('');setPrompt('')
    try {
      let chatId = activeId
      if (!chatId) {
        const c = await api<Chat>('/api/chats', {method:'POST',body:JSON.stringify({title:content.slice(0,70)})})
        chatId = c.id;setActiveId(c.id);setChats(old=>[c,...old])
      }
      const nonce = Date.now().toString()
      const userMsg: Message = {id: nonce+'u',role:'user',content,model:null,created_at:Math.floor(Date.now()/1000)}
      const assistantMsg: Message = {id: nonce+'a',role:'assistant',content:'',model:null,created_at:Math.floor(Date.now()/1000)+1}
      setMessages(old=>[...old,userMsg,assistantMsg])
      await streamMessage(chatId,content,tier,(event,data) => {
        if (event==='meta') {
          setLastModel(data.model)
          setMessages(old=>old.map(m=>m.id===assistantMsg.id?{...m,model:data.model}:m))
        }
        if (event==='token') setMessages(old=>old.map(m=>m.id===assistantMsg.id?{...m,content:m.content+data.text}:m))
      })
      const detail = await api<ChatDetail>(`/api/chats/${encodeURIComponent(chatId)}`)
      setMessages(detail.messages)
    } catch(e) { setError(e instanceof Error ? e.message : 'Unable to send request') }
    finally { setBusy(false) }
  }
  const options = [{tier:'auto',name:'Auto',detail:'Choose a configured tier based on message length'},...models.map(m=>({...m,detail:'Available provider model'}))]
  return <main className="router-layout">
    <section className="chat-panel panel">
      <div className="panel-header chat-header"><div><div className="eyebrow">PRIVATE ROUTER · MVP</div><h1>Confidential Router</h1></div><TrustStatus/></div>
      <div className="session-toolbar"><button onClick={freshChat} disabled={busy}>+ New chat</button><select aria-label="Open conversation" value={activeId} onChange={e=>e.target.value?void openChat(e.target.value):freshChat()} disabled={busy}><option value="">New conversation</option>{chats.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}</select>{activeId&&<button className="text-danger" onClick={()=>void removeChat(activeId)} disabled={busy}>Delete</button>}</div>
      <div className="privacy-banner"><div className="privacy-icon">◈</div><div><strong>Privacy controls are being integrated.</strong><span>Check independent TEE attestations before sending sensitive prompts. This MVP does not yet verify model/TEE measurements.</span></div></div>
      <div className="messages" aria-live="polite">
        {messages.length===0&&<div className="blank-chat"><h2>What would you like to ask?</h2><p>Choose a model tier or use Auto routing.</p></div>}
        {messages.map(m=><div key={m.id} className={`message-row ${m.role}`}><div className="message-bubble"><div className="message-label">{m.role==='user'?'YOU':'3APES'}</div><p>{m.content || (busy ? 'Generating…' : '')}</p>{m.model&&<div className="route-chip">Model: {m.model}</div>}</div></div>)}
      </div>
      {error&&<div className="error-text chat-error" role="alert">{error}</div>}
      <form className="composer" onSubmit={send}><textarea aria-label="Message" placeholder="Ask privately…" value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={(e:KeyboardEvent<HTMLTextAreaElement>)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();e.currentTarget.form?.requestSubmit()}}}/><div className="composer-footer"><span className="composer-security">Transport: HTTPS in production · Attestation pending</span><button className="send-button" type="submit" disabled={busy||!prompt.trim()||models.length===0} aria-label="Send prompt">{busy?'…':'➜'}</button></div></form>
    </section>
    <aside className="router-sidebar"><section className="panel model-panel"><div className="panel-header stack-header"><div><div className="eyebrow">ROUTING MODE</div><h2>Choose compute</h2></div></div><div className="model-list">{options.map(m=><button key={m.tier} className={`model-option ${tier===m.tier?'selected':''}`} onClick={()=>setTier(m.tier)} disabled={busy}><div className="radio"><span/></div><div className="model-copy"><div className="model-title-row"><strong>{m.name}</strong></div><p>{m.detail}</p></div></button>)}{models.length===0&&<p className="muted-pad">No model is configured on the TEE. Set MODEL_*_ID and LLM_BASE_URL.</p>}</div></section><section className="panel route-panel"><div className="eyebrow">LAST ROUTE</div><div className="route-flow"><div className="route-node"><span className="node-dot"/><div><small>Router</small><strong>3apes Rust API</strong></div></div><div className="route-line"><span/></div><div className="route-node active-node"><span className="node-dot"/><div><small>Provider model</small><strong>{lastModel}</strong></div></div></div><div className="security-footnote">Model inference must be independently verified as confidential before advertising this service as TEE-verified.</div></section></aside>
  </main>
}

function ApiView() {
  const [keys,setKeys]=useState<ApiKey[]>([])
  const [keyLabel,setKeyLabel]=useState('')
  const [newKey,setNewKey]=useState('')
  const [models,setModels]=useState<Model[]>([])
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  async function refresh(){try {const [k,m]=await Promise.all([api<ApiKey[]>('/api/keys'),api<{models:Model[]}>('/api/models')]);setKeys(k);setModels(m.models)}catch(e){setError(e instanceof Error?e.message:'Unable to load API information')}}
  useEffect(()=>{void refresh()},[])
  async function createKey(e:FormEvent) {
    e.preventDefault();setBusy(true);setError('')
    try {const r=await api<{key:string}>('/api/keys',{method:'POST',body:JSON.stringify({label:keyLabel})});setNewKey(r.key);setKeyLabel('');await refresh()}
    catch(e){setError(e instanceof Error?e.message:'Could not create key')}
    finally{setBusy(false)}
  }
  async function revokeKey(id:string){if(!window.confirm('Revoke this API key?'))return;try{await api(`/api/keys/${id}`,{method:'DELETE'});await refresh()}catch(e){setError(e instanceof Error?e.message:'Could not revoke key')}}
  return <main className="api-page"><section className="api-title-row"><div><div className="eyebrow">DEVELOPER ACCESS</div><h1>API</h1><p>Manage your API keys and configured model endpoints.</p></div><TrustStatus/></section>
    <section className="metric-grid"><div className="metric-card"><div className="metric-top">Billing</div><div className="metric-value no-prefix">Not enabled</div><div className="metric-caption">No demo credits or fabricated charges</div></div><div className="metric-card"><div className="metric-top">Model endpoints</div><div className="metric-value no-prefix">{models.length}</div><div className="metric-caption">Configured in the router</div></div><div className="metric-card"><div className="metric-top">Active API keys</div><div className="metric-value no-prefix">{keys.length}</div><div className="metric-caption">Stored as hashes in SQLite</div></div></section>
    <section className="panel api-section"><div className="section-title-row"><div><div className="eyebrow">ACCESS</div><h2>API keys</h2><p>Secret value is shown only once at creation.</p></div></div>
      <form className="key-form" onSubmit={createKey}><input aria-label="Key label" placeholder="Key label e.g. development" required maxLength={80} value={keyLabel} onChange={e=>setKeyLabel(e.target.value)}/><button className="primary-button" disabled={busy}>Create key</button></form>
      {newKey&&<div className="new-key"><strong>Copy this key now. It cannot be retrieved later.</strong><code>{newKey}</code><button onClick={()=>void navigator.clipboard.writeText(newKey)}>Copy secret</button><button onClick={()=>setNewKey('')}>Dismiss</button></div>}
      {error&&<div className="error-text" role="alert">{error}</div>}
      <div className="table-shell"><table><thead><tr><th>Label</th><th>Prefix</th><th>Created</th><th>Last used</th><th/></tr></thead><tbody>{keys.map(k=><tr key={k.id}><td><strong>{k.label}</strong></td><td><code>{k.prefix}…</code></td><td>{new Date(k.created_at*1000).toLocaleDateString()}</td><td>{k.last_used_at?new Date(k.last_used_at*1000).toLocaleString():'Never'}</td><td><button className="text-danger" onClick={()=>void revokeKey(k.id)}>Revoke</button></td></tr>)}{keys.length===0&&<tr><td colSpan={5}>No API keys yet</td></tr>}</tbody></table></div>
    </section><section className="panel api-section"><div className="section-title-row"><div><div className="eyebrow">MODELS</div><h2>Available inference</h2><p>Live configured model IDs; pricing and remote attestation not yet integrated.</p></div></div><div className="table-shell"><table><thead><tr><th>Tier</th><th>Provider model ID</th><th>Attestation</th></tr></thead><tbody>{models.map(m=><tr key={m.tier}><td>{m.tier}</td><td><code>{m.name}</code></td><td>Not verified</td></tr>)}{models.length===0&&<tr><td colSpan={3}>No models configured</td></tr>}</tbody></table></div></section>
  </main>
}

export default function App() {
  const [email,setEmail]=useState('')
  const [loading,setLoading]=useState(hasSession())
  const [view,setView]=useState<View>('router')
  useEffect(()=>{if(hasSession())void api<{email:string}>('/api/auth/me').then(r=>setEmail(r.email)).catch(()=>setSessionToken('')).finally(()=>setLoading(false))},[])
  async function logout(){try{await api('/api/auth/logout',{method:'POST'})}catch{}setSessionToken('');setEmail('')}
  if(loading) return <div className="auth-background">Checking session…</div>
  if(!email)return <AuthScreen onLogin={setEmail}/>
  return <div className="app-shell"><header className="topbar"><Logo/><nav className="main-nav" aria-label="Primary"><button className={view==='router'?'active':''} onClick={()=>setView('router')}>Router</button><button className={view==='api'?'active':''} onClick={()=>setView('api')}>API</button></nav><div className="topbar-actions"><span className="user-email">{email}</span><button className="docs-button" onClick={()=>void logout()}>Sign out</button></div></header><div className="page-frame">{view==='router'?<RouterView/>:<ApiView/>}</div></div>
}
