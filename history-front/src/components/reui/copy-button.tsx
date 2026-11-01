// Adapted from ReUI components/copy-button.tsx (MIT). Removed analytics and tooltip dependencies; clipboard errors remain visible.
import {useEffect,useState} from 'react';
import {Check,Copy} from 'lucide-react';
export function CopyButton({value,label='复制'}:{value:string;label?:string}) {
  const [hasCopied,setHasCopied]=useState(false),[error,setError]=useState('');
  useEffect(()=>{ if(hasCopied) { const timer=setTimeout(()=>setHasCopied(false),2000);return()=>clearTimeout(timer); } },[hasCopied]);
  return <span className="copy-wrap"><button className="button subtle copy-button" disabled={!value} onClick={async()=>{try {await navigator.clipboard.writeText(value);setHasCopied(true);setError('');}catch {setError('复制失败，请手动选择文本。');}}} aria-label={hasCopied?'已复制':label}>{hasCopied?<Check size={14}/>:<Copy size={14}/>}<span>{hasCopied?'已复制':label}</span></button>{error&&<span role="status" className="error-text">{error}</span>}</span>;
}
