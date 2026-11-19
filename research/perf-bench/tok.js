const fs=require("fs");
for (const f of process.argv.slice(2)) {
const lines=fs.readFileSync(f,"utf8").split("\n").filter(Boolean);
const seen=new Map();const res={},names={};
for(const l of lines){let o;try{o=JSON.parse(l)}catch{continue}
 if(o.type==="assistant"&&o.message?.usage)seen.set(o.message.id,o.message.usage);
 if(o.type==="user"&&Array.isArray(o.message?.content))for(const b of o.message.content)if(b.type==="tool_result")res[b.tool_use_id]=JSON.stringify(b.content).length;
 if(o.type==="assistant"&&Array.isArray(o.message?.content))for(const b of o.message.content)if(b.type==="tool_use")names[b.id]=b.name}
let t={in:0,cw:0,cr:0,out:0};const ctx=[];for(const u of seen.values()){t.in+=u.input_tokens||0;t.cw+=u.cache_creation_input_tokens||0;t.cr+=u.cache_read_input_tokens||0;t.out+=u.output_tokens||0;ctx.push((u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0)+(u.input_tokens||0))}
const by={};for(const k in res){const n=names[k]||"?";(by[n]??={n:0,kchars:0}).n++;by[n].kchars+=res[k]/1000}
for(const v of Object.values(by))v.kchars=Math.round(v.kchars);
console.log(f.split("/").pop(),"calls",seen.size,JSON.stringify(t),"ctx first",ctx[0],"max",Math.max(...ctx),"last",ctx.at(-1),"cache hit",(t.cr/(t.cr+t.cw+t.in)*100).toFixed(1)+"%");
console.log(" ",JSON.stringify(by));
}
