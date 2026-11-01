const KEY='codex-foreman-history-token';
export function readToken() {const fragment=location.hash.slice(1);if(/^[a-f0-9]{64}$/.test(fragment)){sessionStorage.setItem(KEY,fragment);history.replaceState(null,'',location.pathname+location.search);}return sessionStorage.getItem(KEY)||'';}
const token=readToken();
let csrf='';
export const setCsrf=(value:string)=>{csrf=value;};
export async function api<T>(path:string,input?:unknown,signal?:AbortSignal):Promise<T>{
  const headers:Record<string,string>={Authorization:`Bearer ${token}`};
  if(input!==undefined){headers['Content-Type']='application/json';headers['X-Foreman-CSRF']=csrf;}
  const timeout=AbortSignal.timeout(20000),requestSignal=signal?AbortSignal.any([signal,timeout]):timeout;
  let response:Response;
  try{response=await fetch(path,{headers,method:input===undefined?'GET':'POST',body:input===undefined?undefined:JSON.stringify(input),cache:'no-store',signal:requestSignal});}catch(error){if((error as Error).name==='TimeoutError')throw new Error('请求超过 20 秒未完成，请重试。');throw error;}
  const value=await response.json();if(!response.ok)throw new Error(value.error||`HTTP ${response.status}`);return value;
}
