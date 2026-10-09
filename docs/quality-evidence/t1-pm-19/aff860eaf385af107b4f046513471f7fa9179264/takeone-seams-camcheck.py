import json, sys, math
dirp=sys.argv[1]; seams=[float(x) for x in sys.argv[2:]]
c=json.load(open(f"{dirp}/camera.json"))
fps=60.0
# per-frame motion
m=[None]*len(c)
for i in range(1,len(c)):
    p,q=c[i-1],c[i]
    pcx,pcy=p['x']+p['w']/2,p['y']+p['h']/2
    qcx,qcy=q['x']+q['w']/2,q['y']+q['h']/2
    pan=math.hypot(qcx-pcx,qcy-pcy)/q['w']
    zoom=abs(math.log(q['w']/p['w']))
    m[i]=pan+zoom
for T in seams:
    idx=round(T*fps)
    lo,hi=idx-6,idx+6
    print(f"\n=== seam out={T:.3f}s frame={idx} ===")
    for i in range(max(1,lo),min(len(c),hi+1)):
        f=c[i]
        mark=" <<<SEAM" if i==idx else ""
        print(f"  f{i} t={f['t']:.4f} x={f['x']:.1f} y={f['y']:.1f} w={f['w']:.1f} h={f['h']:.1f} motion={m[i]:.5f}{mark}")
    neigh=[m[i] for i in range(max(1,idx-5),min(len(c),idx+6)) if i!=idx]
    sm=m[idx]
    print(f"  seam motion={sm:.5f}  neighbour min={min(neigh):.5f} max={max(neigh):.5f} mean={sum(neigh)/len(neigh):.5f}  ratio_to_max={sm/max(neigh):.2f}")
