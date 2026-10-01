// UI fragment kit v1. Colours, fonts and surfaces inherit the motion theme and sampled design palette.
const box=(content,extra="")=>h(`<div style="padding:22px 28px;border:1px solid var(--line);border-radius:var(--radius);background:var(--card);color:var(--ink);font:28px/1.35 var(--body);${extra}">${content}</div>`);
FRAGMENTS.button=(s)=>box(esc(s.text??"Create task"),`display:inline-flex;background:${s.state==="hover"?"var(--design-accent, var(--accent))":s.state==="pressed"?"var(--ink)":"var(--card)"};color:${s.state==="pressed"?"var(--card)":s.state==="hover"?"var(--design-on-accent, var(--bg))":"var(--ink)"};transform:scale(${s.state==="pressed"?.96:1})`);
FRAGMENTS.input=(s)=>{
  const el=box(`<span>${esc(s.state==="empty"?"Task title":s.text??"Draft launch announcement")}</span>`,"min-width:560px");
  if(s.state==="typing") tick(ms=>$("span",el).textContent=(s.text??"Draft launch announcement").slice(0,Math.max(0,Math.floor(ms/55))));
  return el;
};
FRAGMENTS.chip=s=>box(esc(s.text??"High priority"),"display:inline-flex;border-radius:999px;padding:10px 24px;background:var(--design-accent, var(--accent));color:var(--design-on-accent, var(--bg))");
FRAGMENTS.toast=s=>box(`<span style="font-family:var(--symbols)">✓</span> &nbsp; ${esc(s.text??"Task created")}`,"background:var(--ink);color:var(--card)");
FRAGMENTS["feed-row"]=s=>box(`<b>Umer</b> ${esc(s.text??"moved Draft launch announcement")}<div style="font:18px var(--mono);margin-top:10px">Just now</div>`);
FRAGMENTS.counter=s=>{const el=box("0","font:80px var(--mono)");tick(ms=>el.textContent=String(Math.round(60*smootherstep(Math.max(0,Math.min(1,ms/1500))))));return el;};
FRAGMENTS["line-chart"]=()=>box(`<svg width="560" height="190" viewBox="0 0 560 190"><path d="M0 160 L80 125 L160 135 L240 75 L320 95 L400 45 L480 60 L560 10" fill="none" stroke="var(--design-accent, var(--accent))" stroke-width="6"/><path d="M0 185 H560" stroke="var(--line)"/></svg>`);
FRAGMENTS["bar-chart"]=()=>box(`<svg width="560" height="190" viewBox="0 0 560 190">${[60,90,80,130,110,160,150,180].map((v,i)=>`<rect x="${i*70}" y="${190-v}" width="45" height="${v}" rx="5" fill="var(--design-accent, var(--accent))"/>`).join("")}</svg>`);
FRAGMENTS.spinner=()=>{const el=box(`<svg width="60" height="60" viewBox="0 0 60 60"><circle cx="30" cy="30" r="24" fill="none" stroke="var(--line)" stroke-width="5"/><path d="M30 6 A24 24 0 0 1 54 30" fill="none" stroke="var(--design-accent, var(--accent))" stroke-width="5"/></svg>`);tick(ms=>$("svg",el).style.transform=`rotate(${ms*.36}deg)`);return el;};
FRAGMENTS["browser-chrome"]=(s,ctx)=>CHROME.browser(ctx);
FRAGMENTS["phone-chrome"]=(s,ctx)=>CHROME.phone(ctx);
PATTERNS.fragment=(layer,s,ctx)=>{
  const build=FRAGMENTS[s.kind];if(!build)throw new Error(`unknown fragment ${s.kind}`);
  const el=build(s,ctx);const wrap=h('<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center"></div>');wrap.append(el);layer.append(wrap);
};
