--3caef74fc75956c81f4ed36f1a53406d2028220d23e2fa23dba8dd8d019b
Content-Disposition: form-data; name="worker.js"; filename="worker.js"
Content-Type: application/javascript+module

export default {async fetch(request,env){return Response.json({ok:true,service:"ANGRY NFT Storage",pinataConfigured:Boolean(env.PINATA_JWT)});}};
--3caef74fc75956c81f4ed36f1a53406d2028220d23e2fa23dba8dd8d019b--
