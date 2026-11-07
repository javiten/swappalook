import { createClient } from '@supabase/supabase-js'
const url=process.env.NEXT_PUBLIC_SUPABASE_URL, key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY||process.env.SUPABASE_ANON_KEY
const sb=createClient(url,key,{auth:{persistSession:false}})
const {error:le}=await sb.auth.signInWithPassword({email:'nails@swappalook.example',password:process.env.DEMO_NAILS_PASSWORD})
if(le){console.log('login',le.message);process.exit(1)}
const {data:svcs}=await sb.from('services').select('id,title,duration_minutes,business_id,businesses(display_name)').eq('is_active',true)
console.log(svcs.map(s=>`${s.businesses.display_name} | ${s.title} | ${s.duration_minutes} | ${s.id}`).join('\n'))
const req=svcs.find(s=>s.title==='Masaje relajante'), off=svcs.find(s=>s.title==='Manicura clásica')
const now=new Date(); const floor=new Date(Math.floor(now.getTime()/900000)*900000)
const day=86400000
async function t(label,a,b){const {data,error}=await sb.rpc('create_exchange',{p_requested_service_id:req.id,p_offered_service_id:off.id,p_requested_start:a.toISOString(),p_offered_start:b.toISOString(),p_note:null});console.log(label,'->',error?`${error.code} ${error.message}`:`OK ${data}`)}
await t('A: current-minute offered',new Date(floor.getTime()+4*day),new Date(now.getTime()))
await t('B: current slot floor (past)',new Date(floor.getTime()+4*day),floor)
await t('C: future, aligned',new Date(floor.getTime()+4*day+3600000),new Date(floor.getTime()+6*day+7200000))
await t('D: future, NOT 15-min aligned',new Date(floor.getTime()+4*day+3600000+60000),new Date(floor.getTime()+6*day+7200000))
console.log('now',now.toISOString())
