// Scanner di letterali stringa TypeScript (commenti, regex e template annidati gestiti).
export function scan(s){
  const out=[]; let i=0; let prev=""; // ultimo token significativo
  const strs=[];
  function tmpl(){ // s[i] === "`"
    i++; let cur=""; const parts=[];
    while(i<s.length&&s[i]!=="`"){
      if(s[i]==="\\"){ cur+=s.slice(i,i+2); i+=2; continue; }
      if(s[i]==="$"&&s[i+1]==="{"){ parts.push(cur); cur=""; i+=2; let d=1; // scan expression
        const start=i;
        while(i<s.length&&d>0){ const c=s[i];
          if(c==="}"){d--; if(d===0){break;} i++; continue;}
          if(c==="{"){d++; i++; continue;}
          if(c==='"'||c==="'"){ str(c); continue;}
          if(c==="`"){ tmpl(); continue;}
          i++; }
        i++; continue; }
      cur+=s[i]; i++; }
    parts.push(cur); i++;
    strs.push({kind:"tpl",parts}); prev="`";
  }
  function str(q){ let j=i+1, v=""; while(j<s.length&&s[j]!==q){ if(s[j]==="\\"){ const n=s[j+1]; if(n==="n")v+="\n"; else if(n==="t")v+="\t"; else if(n==="u"&&/[0-9a-f]{4}/i.test(s.slice(j+2,j+6))){v+=String.fromCharCode(parseInt(s.slice(j+2,j+6),16)); j+=4;} else if(n==="x"){v+=String.fromCharCode(parseInt(s.slice(j+2,j+4),16)); j+=2;} else v+=n; j+=2; continue;} if(s[j]==="\n") break; v+=s[j]; j++; } strs.push({kind:"str",v,pos:i}); i=j+1; prev=q; }
  while(i<s.length){
    const c=s[i];
    if(c==="/"&&s[i+1]==="/"){ const e=s.indexOf("\n",i); i=e<0?s.length:e; continue; }
    if(c==="/"&&s[i+1]==="*"){ const e=s.indexOf("*/",i+2); i=e<0?s.length:e+2; continue; }
    if(c==='"'||c==="'"){ str(c); continue; }
    if(c==="`"){ tmpl(); continue; }
    if(c==="/"){ // regex o divisione
      if(/[(,=:\[!&|?{};+\-*%<>~^]|^$|return|typeof|case/.test(prev)||prev===""){ i++; let cls=false; while(i<s.length){ if(s[i]==="\\"){i+=2;continue;} if(s[i]==="[")cls=true; else if(s[i]==="]")cls=false; else if(s[i]==="/"&&!cls)break; else if(s[i]==="\n")break; i++; } i++; while(/[a-z]/.test(s[i]||""))i++; prev="/re"; continue; } }
    if(!/\s/.test(c)){ // aggiorna prev con parola o carattere
      if(/[A-Za-z_$0-9]/.test(c)){ let j=i; while(/[A-Za-z_$0-9]/.test(s[j]||""))j++; prev=s.slice(i,j); i=j; continue; }
      prev=c; }
    i++; }
  return strs;
}
