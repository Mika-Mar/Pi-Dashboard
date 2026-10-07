

export async function jget(url, init={}){
    const r = await fetch(url, { headers: {"Accept":"application/json"}, ...init});
    if(!r.ok) {
        const error = new Error(`HTTP ${r.status} ${url}`);
        error.data = await r.json().catch(() => ({}));
        throw error;
    }
    return await r.json();
}

export async function jpost(url, body){
    return jget(url,{method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body||{})});
}
