export default {async fetch(request,env){return Response.json({ok:true,service:"ANGRY NFT Storage",pinataConfigured:Boolean(env.PINATA_JWT)});}};
