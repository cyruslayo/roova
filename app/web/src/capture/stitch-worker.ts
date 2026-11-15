// Browser worker for sequential frame decode/resize. Falls back to main-thread
// preparation on Safari versions without worker OffscreenCanvas support.
self.onmessage = async (event: MessageEvent<{ id: number; image: Blob; width: number; height: number }>) => {
  const {id,image,width,height}=event.data;
  let bitmap:ImageBitmap | null=null;
  try {
    bitmap=await createImageBitmap(image);
    const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d',{willReadFrequently:true});
    if(!ctx)throw new Error('Worker canvas unavailable');
    ctx.drawImage(bitmap,0,0,width,height);
    const pixels=ctx.getImageData(0,0,width,height).data;
    (self as unknown as {postMessage:(data:unknown,transfer:Transferable[])=>void}).postMessage({id,pixels:pixels.buffer},[pixels.buffer as ArrayBuffer]);
  } catch(error) {self.postMessage({id,error:error instanceof Error?error.message:'Frame preparation failed'});}
  finally {bitmap?.close();}
};
