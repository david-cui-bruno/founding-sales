/** RIFF animation flags/chunks are authoritative even if a decoder exposes one page. */
export function isBoundedStillWebp(body:Buffer):boolean{
 if(body.length<20||body.readUInt32LE(4)+8!==body.length)return false;
 let image=false;
 for(let offset=12;offset<body.length;){
  if(body.length-offset<8)return false;
  const type=body.toString('ascii',offset,offset+4),length=body.readUInt32LE(offset+4),payload=offset+8;
  if(length>body.length-payload)return false;
  if(type==='ANIM'||type==='ANMF')return false;
  if(type==='VP8X'){
   if(length!==10||(body[payload]!&2)!==0)return false;
   const width=body.readUIntLE(payload+4,3)+1,height=body.readUIntLE(payload+7,3)+1;
   if(width*height>36_000_000)return false;
  }
  if(type==='VP8 '||type==='VP8L'){if(image)return false;image=true;}
  offset=payload+length+(length&1);
  if(offset>body.length)return false;
 }
 return image;
}
