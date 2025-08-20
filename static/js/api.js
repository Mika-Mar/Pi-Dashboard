

export async function jget(url, init={}){
    const r = await fetch(url, { headers: {"Accept":"application/json"}, ...init});
    if(!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.json();
}

export async function jpost(url, body){
    return jget(url,{method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body||{})});
}