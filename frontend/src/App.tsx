import { FormEvent, KeyboardEvent, useEffect, useState } from 'react'
import { api, setSessionToken, hasSession, streamMessage, type ApiKey, type Chat, type ChatDetail, type Message, type Model } from './api'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

type View = 'router' | 'api'

function Logo() {
  return <div className="brand-lockup"><div className="logo-mark"><span/><span/><span/></div><div><div className="brand-name">3apes</div><div className="brand-subtitle">Confidential AI Router</div></div></div>
}
function TrustStatus() {
  return <div className="trust-warning" title="HTTPS is not remote attestation. This MVP does not yet verify TDX quotes or model attestations.">Attestation not verified</div>
}
type AuthMode = 'login' | 'register' | 'forgot' | 'reset'
function AuthScreen({ onLogin }: { onLogin: (email: string) => void }) {
  // The token travels in the URL fragment, not in the HTTP request to Cloudflare.
  const [resetToken] = useState(() => new URLSearchParams(window.location.hash.split('?')[1] || '').get('token') || '')
  const [mode, setMode] = useState<AuthMode>(resetToken ? 'reset' : 'login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (resetToken) window.history.replaceState(null, '', window.location.pathname + window.location.search)
  }, [resetToken])
  function switchMode(next: AuthMode) { setMode(next); setError(''); setNotice(''); setPassword('') }
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(''); setNotice('')
    try {
      if (mode === 'forgot') {
        const result = await api<{message:string}>('/api/auth/forgot-password', {method:'POST',body:JSON.stringify({email})})
        setNotice(result.message)
      } else if (mode === 'reset') {
        await api('/api/auth/reset-password', {method:'POST',body:JSON.stringify({token:resetToken,password})})
        setNotice('Your password was changed. You can sign in with your new password.')
        setMode('login'); setPassword('')
      } else {
        if (mode === 'register') await api('/api/auth/register', {method:'POST',body:JSON.stringify({email,password})})
        const session = await api<{token:string;email:string}>('/api/auth/login', {method:'POST',body:JSON.stringify({email,password})})
        setSessionToken(session.token); onLogin(session.email)
      }
    } catch(e) {setError(e instanceof Error ? e.message : 'Request failed. Please try again.')}
    finally {setBusy(false)}
  }
  return <div className="auth-background"><div className="auth-layout">
    <section className="auth-story" aria-label="What is 3apes">
      <Logo/>
      <div className="auth-story-content">
        <div className="auth-kicker">PRIVATE AI · OPEN MODELS</div>
        <h1>Ask AI questions.<br/><span>Keep control of your data.</span></h1>
        <p className="auth-lead">3apes gives you access to open-weight AI models through protected computing environments called <strong>Trusted Execution Environments (TEEs)</strong>.</p>
        <div className="auth-points">
          <div><strong>What makes it different?</strong><p>Typical AI services ask you to trust their policies about how they handle your data. TEEs add hardware-backed protection while your request is processed.</p></div>
          <div><strong>Trust evidence, not just promises.</strong><p>TEE technology allows independent checks of the software running inside the protected environment. Hardware attestation offers a way to verify those claims.</p></div>
          <div><strong>Choose your AI model.</strong><p>Pick from the models Phala makes available, all in one straightforward chat interface.</p></div>
        </div>
      </div>
      <p className="auth-transparency">Important: Independent verification of 3apes and the inference path is still being developed. This release does not yet offer end-to-end cryptographic verification.</p>
    </section>
    <section className="auth-card" aria-label="3apes account">
      <div className="auth-card-head"><div className="eyebrow">YOUR PRIVATE AI WORKSPACE</div><h2>{mode==='register'?'Create an account':mode==='forgot'?'Forgot your password?':mode==='reset'?'Choose a new password':'Welcome back'}</h2>
        <p>{mode==='forgot'?'Enter your account email and we will send you a secure reset link.':mode==='reset'?'Your new password must be at least 12 characters.':mode==='register'?'Create your 3apes account to start chatting.':'Sign in to access your conversations and models.'}</p></div>
      <form className="auth-form" onSubmit={submit}>
        {mode!=='reset'&&<label>Email address<input type="email" required autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/></label>}
        {mode!=='forgot'&&<label>{mode==='reset'?'New password':'Password'}<input type="password" minLength={mode==='login'?undefined:12} maxLength={128} required autoComplete={mode==='login'?'current-password':'new-password'} value={password} onChange={e=>setPassword(e.target.value)} placeholder={mode==='login'?'Enter your password':'At least 12 characters'}/></label>}
        {error&&<div className="error-text" role="alert">{error}</div>}
        {notice&&<div className="auth-notice" role="status">{notice}</div>}
        <button className="primary-button" disabled={busy}>{busy?'Working…':mode==='forgot'?'Send reset link':mode==='reset'?'Change password':mode==='register'?'Create account':'Sign in'}</button>
      </form>
      <div className="auth-actions">
        {mode==='login'&&<><button className="text-action" onClick={()=>switchMode('forgot')}>Forgot password?</button><button className="text-action" onClick={()=>switchMode('register')}>Create an account</button></>}
        {mode==='register'&&<button className="text-action" onClick={()=>switchMode('login')}>Already have an account? Sign in</button>}
        {mode==='forgot'&&<button className="text-action" onClick={()=>switchMode('login')}>Back to sign in</button>}
        {mode==='reset'&&<button className="text-action" onClick={()=>switchMode('login')}>Back to sign in</button>}
      </div>
      <p className="auth-card-footnote">Protected infrastructure, transparent verification status. Never share your password or reset link.</p>
    </section>
  </div></div>
}

function RouterView() {
  const [chats, setChats] = useState<Chat[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [messages, setMessages] = useState<Message[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [modelId, setModelId] = useState(() => localStorage.getItem('threeapes_model_id') || '')
  const [modelSearch, setModelSearch] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [lastModel, setLastModel] = useState('None yet')

  useEffect(() => {
    void Promise.all([api<Chat[]>('/api/chats'), api<{models:Model[]}>('/api/models')]).then(([list,m]) => {
      setChats(list); setModels(m.models)
      setModelId(previous => {
        const selected = m.models.find(x => x.id === previous)?.id || m.models[0]?.id || ''
        if (selected) localStorage.setItem('threeapes_model_id', selected)
        return selected
      })

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
      await streamMessage(chatId,content,modelId,(event,data) => {
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
  const visibleModels = models.filter(m => `${m.name} ${m.id}`.toLowerCase().includes(modelSearch.trim().toLowerCase()))
  return <main className="router-layout">
    <section className="chat-panel panel">
      <div className="panel-header chat-header"><div><div className="eyebrow">PRIVATE ROUTER · MVP</div><h1>Confidential Router</h1></div><TrustStatus/></div>
      <div className="session-toolbar"><button onClick={freshChat} disabled={busy}>+ New chat</button><select aria-label="Open conversation" value={activeId} onChange={e=>e.target.value?void openChat(e.target.value):freshChat()} disabled={busy}><option value="">New conversation</option>{chats.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}</select>{activeId&&<button className="text-danger" onClick={()=>void removeChat(activeId)} disabled={busy}>Delete</button>}</div>
      <div className="privacy-banner"><div className="privacy-icon">◈</div><div><strong>Privacy controls are being integrated.</strong><span>Check independent TEE attestations before sending sensitive prompts. This MVP does not yet verify model/TEE measurements.</span></div></div>
      <div className="messages" aria-live="polite">
        {messages.length===0&&<div className="blank-chat"><h2>What would you like to ask?</h2><p>Choose any available Phala model to begin.</p></div>}
        {messages.map(m=><div key={m.id} className={`message-row ${m.role}`}><div className="message-bubble"><div className="message-label">{m.role==='user'?'YOU':'3APES'}</div>{m.role === 'assistant' ? (
  <div className="message-markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
      {m.content || (busy ? 'Generating…' : '')}
    </ReactMarkdown>
  </div>
) : (
  <p className="user-message-text">{m.content}</p>
)}{m.model&&<div className="route-chip">Model: {m.model}</div>}</div></div>)}
      </div>
      {error&&<div className="error-text chat-error" role="alert">{error}</div>}
      <form className="composer" onSubmit={send}><textarea aria-label="Message" placeholder="Ask privately…" value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={(e:KeyboardEvent<HTMLTextAreaElement>)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();e.currentTarget.form?.requestSubmit()}}}/><div className="composer-footer"><span className="composer-security">Transport: HTTPS in production · Attestation pending</span><button className="send-button" type="submit" disabled={busy||!prompt.trim()||!modelId} aria-label="Send prompt">{busy?'…':'➜'}</button></div></form>
    </section>
    <aside className="router-sidebar"><section className="panel model-panel">
      <div className="panel-header stack-header"><div><div className="eyebrow">PHALA MODEL CATALOG</div><h2>Select a model</h2></div><span className="model-count">{models.length} models</span></div>
      <div className="model-selector-tools"><input aria-label="Search available models" placeholder="Search models…" value={modelSearch} onChange={e=>setModelSearch(e.target.value)} /></div>
      <div className="model-list" role="radiogroup" aria-label="Available AI models">
        {visibleModels.map(m=><button role="radio" aria-checked={modelId===m.id} key={m.id} className={`model-option ${modelId===m.id?'selected':''}`} onClick={()=>{setModelId(m.id);localStorage.setItem('threeapes_model_id',m.id)}} disabled={busy}>
          <div className="radio"><span/></div><div className="model-copy"><div className="model-title-row"><strong>{m.name}</strong></div><p>{m.id}</p>{m.context_window&&<small>Context: {Math.round(m.context_window/1000)}K tokens</small>}</div>
        </button>)}
        {models.length===0&&<p className="muted-pad">No models loaded. Check Phala API availability and your backend credentials.</p>}
        {models.length>0&&visibleModels.length===0&&<p className="muted-pad">No matching models.</p>}
      </div>
    </section>
    <section className="panel route-panel"><div className="eyebrow">LAST ROUTE</div><div className="route-flow"><div className="route-node"><span className="node-dot"/><div><small>Router</small><strong>3apes Rust API</strong></div></div><div className="route-line"><span/></div><div className="route-node active-node"><span className="node-dot"/><div><small>Provider model</small><strong>{lastModel}</strong></div></div></div><div className="security-footnote">Model inference has not yet been independently verified as confidential by this application.</div></section>
    </aside>
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
  return <main className="api-page"><section className="api-title-row"><div><div className="eyebrow">DEVELOPER ACCESS</div><h1>API</h1><p>Manage your API keys and view models currently returned by Phala.</p></div><TrustStatus/></section>
    <section className="metric-grid"><div className="metric-card"><div className="metric-top">Billing</div><div className="metric-value no-prefix">Not enabled</div><div className="metric-caption">No demo credits or fabricated charges</div></div><div className="metric-card"><div className="metric-top">Model endpoints</div><div className="metric-value no-prefix">{models.length}</div><div className="metric-caption">Available through Phala</div></div><div className="metric-card"><div className="metric-top">Active API keys</div><div className="metric-value no-prefix">{keys.length}</div><div className="metric-caption">Stored as hashes in SQLite</div></div></section>
    <section className="panel api-section"><div className="section-title-row"><div><div className="eyebrow">ACCESS</div><h2>API keys</h2><p>Secret value is shown only once at creation.</p></div></div>
      <form className="key-form" onSubmit={createKey}><input aria-label="Key label" placeholder="Key label e.g. development" required maxLength={80} value={keyLabel} onChange={e=>setKeyLabel(e.target.value)}/><button className="primary-button" disabled={busy}>Create key</button></form>
      {newKey&&<div className="new-key"><strong>Copy this key now. It cannot be retrieved later.</strong><code>{newKey}</code><button onClick={()=>void navigator.clipboard.writeText(newKey)}>Copy secret</button><button onClick={()=>setNewKey('')}>Dismiss</button></div>}
      {error&&<div className="error-text" role="alert">{error}</div>}
      <div className="table-shell"><table><thead><tr><th>Label</th><th>Prefix</th><th>Created</th><th>Last used</th><th/></tr></thead><tbody>{keys.map(k=><tr key={k.id}><td><strong>{k.label}</strong></td><td><code>{k.prefix}…</code></td><td>{new Date(k.created_at*1000).toLocaleDateString()}</td><td>{k.last_used_at?new Date(k.last_used_at*1000).toLocaleString():'Never'}</td><td><button className="text-danger" onClick={()=>void revokeKey(k.id)}>Revoke</button></td></tr>)}{keys.length===0&&<tr><td colSpan={5}>No API keys yet</td></tr>}</tbody></table></div>
    </section><section className="panel api-section"><div className="section-title-row"><div><div className="eyebrow">MODELS</div><h2>Available inference</h2><p>Live provider model catalog. Availability and confidential-computing claims require separate verification.</p></div></div><div className="table-shell"><table><thead><tr><th>Model</th><th>Provider model ID</th><th>Attestation</th></tr></thead><tbody>{models.map(m=><tr key={m.id}><td>{m.name}</td><td><code>{m.id}</code></td><td>Not verified</td></tr>)}{models.length===0&&<tr><td colSpan={3}>No models available</td></tr>}</tbody></table></div></section>
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
