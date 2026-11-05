'use strict';
/* ───────── fictional data ───────── */
const ICONS={
today:'<path d="M4 13l2.5-7h11L20 13"/><path d="M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5h-5a3 3 0 0 1-6 0H4z"/>',
prospects:'<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/>',
mail:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
social:'<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5"/>',
settings:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
phone:'<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
hang:'<path d="M3 13.5c5-4.6 13-4.6 18 0l-2.3 2.7-3.6-1.6v-2.6a12 12 0 0 0-6.2 0v2.6l-3.6 1.6z"/>',
reply:'<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v5"/>',
pen:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
decide:'<circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/>',
check:'<path d="M20 6 9 17l-5-5"/>',
search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
mic:'<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/>',
plus:'<path d="M12 5v14M5 12h14"/>',
back:'<path d="m15 18-6-6 6-6"/>',
arrow:'<path d="M5 12h14M13 6l6 6-6 6"/>',
clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
copy:'<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
spark:'<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
skip:'<path d="M5 4l10 8-10 8z"/><path d="M19 5v14"/>',
pause:'<path d="M9 5v14M15 5v14"/>',
x:'<path d="M18 6 6 18M6 6l12 12"/>',
book:'<path d="M4 4h10a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4z"/><path d="M4 16a4 4 0 0 1 4-4h10"/>',
chat:'<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/>',
cal:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
moon:'<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
flag:'<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
board:'<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>'
};
const ic=n=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const para=t=>esc(t).split(/\n\n+/).map(p=>`<p>${p.replace(/\n/g,'<br>')}</p>`).join('');
const initials=n=>n.replace(/&/g,'').split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase();

const CO={
harbor:{name:'Harbor Property Co.',city:'Austin, TX',local:'10:14 AM',kind:'Residential property management',person:'Morgan Ellis',role:'Owner',first:'Morgan',phone:'(202) 555-0142',phoneSrc:2,status:'call',fit:'ordinary',
 why:[['Manages residential rentals across Austin',1],['Morgan Ellis is listed as the owner',1],['Residents are told to call the office for maintenance',2]],
 unknown:['Who makes maintenance decisions day to day','How many homes they manage','Which property-management software they use'],
 ask:['When a resident calls after hours, who picks up today?','Who approves vendor work when something urgent comes in?'],
 sources:[{n:1,page:'harbor.example/about',title:'About us',quote:'Morgan Ellis, Owner. We manage residential properties throughout Austin.',seen:'Oct 28',exp:'Jan 26'},{n:2,page:'harbor.example/contact',title:'Contact',quote:'Residents: for maintenance requests, call our office at (202) 555-0142.',seen:'Oct 28',exp:'Jan 26'}],
 activity:[['Oct 28','Research published','From 2 pages on harbor.example']]},
bluestem:{name:'Bluestem Management',city:'Omaha, NE',local:'10:14 AM',kind:'Residential and HOA management',person:null,role:null,first:null,phone:'(402) 555-0119',phoneSrc:1,status:'call',fit:'supported',
 why:[['Lists 14 rental communities around Omaha',2],['Office line is published on every page',1]],
 unknown:['No person is named on the site','Whether maintenance is handled in-house'],
 ask:['Who handles maintenance calls for your communities?','How do residents reach you after the office closes?'],
 sources:[{n:1,page:'bluestem.example',title:'Home',quote:'Call us: (402) 555-0119 · Mon–Fri 8–5',seen:'Oct 30',exp:'Jan 28'},{n:2,page:'bluestem.example/communities',title:'Communities',quote:'Fourteen rental communities across the Omaha metro.',seen:'Oct 30',exp:'Jan 28'}],
 activity:[['Oct 30','Research published','From 2 pages on bluestem.example']]},
pinecrest:{name:'Pinecrest Rentals',city:'Tulsa, OK',local:'10:14 AM',kind:'Single-family rentals',person:'Avery Brooks',role:'Maintenance coordinator',first:'Avery',phone:'(918) 555-0163',phoneSrc:1,status:'call',fit:'supported',
 why:[['Avery Brooks coordinates maintenance requests',1],['Around 300 single-family homes listed',2]],
 unknown:['Whether Avery decides on vendors or just schedules them'],
 ask:['What happens to a maintenance call that comes in at night?','How many of those turn out to be real emergencies?'],
 sources:[{n:1,page:'pinecrest.example/team',title:'Our team',quote:'Avery Brooks — Maintenance Coordinator. Avery handles all resident maintenance requests.',seen:'Oct 31',exp:'Jan 29'},{n:2,page:'pinecrest.example',title:'Home',quote:'Proudly managing 300+ homes in the Tulsa area.',seen:'Oct 31',exp:'Jan 29'}],
 activity:[['Oct 31','Research published','From 2 pages on pinecrest.example']]},
willow:{name:'Willow Street Properties',city:'Sacramento, CA',local:'8:14 AM',kind:'Residential property management',person:'Jordan Kim',role:'Principal',first:'Jordan',phone:'(916) 555-0137',phoneSrc:1,status:'call',fit:'ordinary',
 why:[['Jordan Kim is listed as principal and broker',1],['Office line published on the contact page',1]],
 unknown:['Team size','How after-hours calls are handled'],
 ask:['Who on your team takes after-hours calls?'],
 sources:[{n:1,page:'willowstreet.example/contact',title:'Contact',quote:'Jordan Kim, Principal/Broker · Office (916) 555-0137',seen:'Nov 1',exp:'Jan 30'}],
 activity:[['Nov 1','Research published','From 1 page on willowstreet.example']]},
maple:{name:'Maple & Main Property Group',city:'Madison, WI',local:'10:14 AM',kind:'Residential property management',person:'Sam Patel',role:'Owner',first:'Sam',phone:'(608) 555-0128',phoneSrc:1,status:'callback',fit:'supported',callback:'Today after 2:00 PM their time',
 why:[['Sam Patel is the owner and picks up the office line',1],['Talked briefly on Nov 4 and asked for a callback',0]],
 unknown:['How many units they manage'],
 ask:['Pick up where you left off: they were busy with move-ins.'],
 sources:[{n:1,page:'mapleandmain.example/about',title:'About',quote:'Sam Patel founded Maple & Main in 2011 and still answers the office phone.',seen:'Oct 29',exp:'Jan 27'}],
 activity:[['Nov 4','Call · Call back later','“Busy with move-ins this morning, try me after 2.”'],['Oct 29','Research published','From 1 page on mapleandmain.example']]},
cedar:{name:'Cedar Row Rentals',city:'Portland, OR',local:'8:14 AM',kind:'Residential rentals',person:'Riley Shaw',role:'Owner',first:'Riley',phone:null,status:'review',fit:'ordinary',
 review:{kind:'phone',q:'Which number reaches Cedar Row’s office?',why:'The site lists two numbers. Pick the one that rings the office during business hours.',options:[{v:'(503) 555-0171',quote:'Office: (503) 555-0171 · Mon–Fri 9–5',page:'cedarrow.example/contact'},{v:'(503) 555-0188',quote:'After-hours emergencies only: (503) 555-0188',page:'cedarrow.example/residents'}]},
 why:[['Riley Shaw is listed as owner',1],['Manages rentals in inner Portland',1]],unknown:['Which number reaches the office'],ask:['Who handles after-hours calls today?'],
 sources:[{n:1,page:'cedarrow.example/contact',title:'Contact',quote:'Office: (503) 555-0171 · Mon–Fri 9–5',seen:'Nov 2',exp:'Jan 31'},{n:2,page:'cedarrow.example/residents',title:'Residents',quote:'After-hours emergencies only: (503) 555-0188',seen:'Nov 2',exp:'Jan 31'}],
 activity:[['Nov 2','Research published','Needs one decision: phone number']]},
northgate:{name:'Northgate Residential',city:'Columbus, OH',local:'11:14 AM',kind:'Residential property management',person:'Dana Lee',role:'Operations manager',first:'Dana',phone:'(614) 555-0155',phoneSrc:1,status:'review',fit:'ordinary',
 review:{kind:'identity',q:'Is “NGR Property Services LLC” the same company?',why:'The site footer reads “© NGR Property Services LLC”. Everything else on the site says Northgate Residential.'},
 why:[['Dana Lee runs operations',1]],unknown:['Legal name vs. trade name'],ask:['Who decides how resident calls are handled?'],
 sources:[{n:1,page:'northgate.example',title:'Home',quote:'Northgate Residential · Dana Lee, Operations · (614) 555-0155 · © NGR Property Services LLC',seen:'Nov 2',exp:'Jan 31'}],
 activity:[['Nov 2','Research published','Needs one decision: company name']]},
alder:{name:'Alder & Oak Homes',city:'Raleigh, NC',local:'11:14 AM',kind:'Residential property management',person:'Taylor Reed',role:'Property manager',first:'Taylor',phone:'(919) 555-0146',phoneSrc:1,status:'done',fit:'supported',outcome:'Talked',when:'Yesterday',
 why:[['Taylor Reed manages day-to-day operations',1]],unknown:['Budget owner'],ask:['Follow up on pricing and a sample call log'],
 sources:[{n:1,page:'alderoak.example/team',title:'Team',quote:'Taylor Reed, Property Manager',seen:'Oct 27',exp:'Jan 25'}],
 activity:[['Nov 4','Call · Talked','Wants pricing and an example of a weekend call log. Promised an email.'],['Oct 27','Research published','From 1 page on alderoak.example']],
 meeting:{title:'Intro call',when:'Nov 4, 4:20 PM',prep:['Who handles weekend calls now?','What would “good” look like after a month?'],notes:'Taylor handles weekend calls herself on a shared phone. Interested in pricing and a sample of what a weekend log would look like.'}},
riverbend:{name:'Riverbend Homes',city:'Boise, ID',local:'9:14 AM',kind:'Residential rentals',person:'Casey Morgan',role:'Owner',first:'Casey',phone:'(208) 555-0110',phoneSrc:1,status:'done',fit:'ordinary',outcome:'Left voicemail',when:'Today',
 why:[['Casey Morgan is the owner',1]],unknown:['Team size'],ask:[],
 sources:[{n:1,page:'riverbend.example/about',title:'About',quote:'Casey Morgan, Owner',seen:'Oct 30',exp:'Jan 28'}],
 activity:[['Today 9:41 AM','Call · Left voicemail','']]},
summit:{name:'Summitview Residential',city:'Denver, CO',local:'9:14 AM',kind:'Residential property management',person:'Alex Rivera',role:'Owner',first:'Alex',phone:'(303) 555-0192',phoneSrc:1,status:'done',fit:'supported',outcome:'Interested',when:'Nov 3',
 why:[['Alex Rivera owns and runs the office',1]],unknown:['Timeline for a decision'],ask:['Follow up on the trial question'],
 sources:[{n:1,page:'summitview.example/about',title:'About',quote:'Alex Rivera, Owner · (303) 555-0192',seen:'Oct 29',exp:'Jan 27'}],
 activity:[['Nov 3','Call · Interested','Asked what a 30-day trial would look like.']]},
granite:{name:'Granite Peak Rentals',city:'Salt Lake City, UT',local:'9:14 AM',kind:'Residential rentals',person:'Jesse Park',role:'Owner',first:'Jesse',phone:'(801) 555-0174',phoneSrc:1,status:'done',fit:'ordinary',outcome:'Not interested',when:'Nov 2',
 why:[['Jesse Park is listed as owner',1]],unknown:[],ask:[],
 sources:[{n:1,page:'granitepeak.example',title:'Home',quote:'Jesse Park, Owner',seen:'Oct 28',exp:'Jan 26'}],
 activity:[['Nov 2','Call · Not interested','Happy with their current answering service.']]}
};
const mk=(id,name,city,person,role,phone,deal,act)=>{CO[id]={name,city,local:'10:14 AM',kind:'Residential property management',person,role,first:person.split(' ')[0],phone,phoneSrc:1,status:'done',fit:'supported',outcome:'Talked',when:act[act.length-1][0],
 why:[[`${person} is the ${role.toLowerCase()}`,1]],unknown:[],ask:[],sources:[{n:1,page:name.toLowerCase().replace(/[^a-z]+/g,'')+'.example/about',title:'About',quote:`${person}, ${role} · ${phone}`,seen:'Oct 20',exp:'Jan 18'}],activity:act,deal}};
mk('brightline','Brightline Homes','Charlotte, NC','Priya Shah','Owner','(704) 555-0133',{stage:'decision',mrr:450,since:'Oct 30',next:'Waiting on her business partner’s sign-off'},[['Oct 30','Demo · Went well','Wants to start with two properties.'],['Oct 24','Call · Interested','']]);
mk('meadow','Meadowbrook Rentals','Knoxville, TN','Chris Doyle','Owner','(865) 555-0181',{stage:'onboarding',mrr:300,since:'Oct 27',next:'Forward the after-hours line'},[['Oct 27','Signed up',''],['Oct 21','Demo · Went well','']]);
mk('kingsley','Kingsley Property Co.','Richmond, VA','Dana Wu','Owner','(804) 555-0127',{stage:'live',mrr:300,since:'Oct 22',next:'Check in after the first month'},[['Oct 22','Went live',''],['Oct 14','Demo · Went well','']]);
CO.alder.deal={stage:'interested',mrr:0,since:'Nov 4',next:'Send pricing and a sample weekend log'};
CO.summit.deal={stage:'demo',mrr:300,since:'Nov 3',meeting:'Demo · Tue, Nov 10, 1:00 PM',next:'They booked through your calendar link'};
CO.granite.deal={stage:'lost',mrr:0,since:'Nov 2',reason:'Happy with their current answering service'};
const ORDER=['harbor','bluestem','pinecrest','willow','maple','cedar','northgate','alder','summit','brightline','meadow','kingsley','riverbend','granite'];
const STAGES=[['interested','Interested','var(--blue)'],['demo','Demo booked','var(--violet)'],['decision','Decision pending','var(--amber)'],['onboarding','Onboarding','var(--accent)'],['live','Live','var(--accent)'],['lost','Lost','var(--red)']];
const NOW=new Date(2026,10,5),STUCK_DAYS=5;
const daysSince=s=>!s||s==='Today'?0:Math.round((NOW-new Date(`${s} 2026`))/864e5);
const stuck=id=>{const d=co(id).deal;return d&&!['live','lost'].includes(d.stage)&&daysSince(d.since)>STUCK_DAYS?daysSince(d.since):0};
const emailOf=c=>`${(c.first||'office').toLowerCase()}@${c.name.toLowerCase().replace(/[^a-z]+/g,'')}.example`;
const COLS=[['leads','To call','var(--ink3)'],...STAGES];
const stageName=k=>COLS.find(x=>x[0]===k)?.[1]||k;
const colOf=c=>c.deal?c.deal.stage:(c.status==='call'||c.status==='callback')?'leads':null;
const LOST_REASONS=['Not interested','Went with someone else','Bad timing','Too expensive','Stopped responding'];

const THREADS={
jamie:{from:'Jamie Ortiz',email:'jamie@juniper-residential.example',company:'Juniper Residential',subject:'Re: After-hours maintenance calls at Juniper',time:'Today, 9:12 AM',short:'9:12 AM',
 body:'Hi David,\n\nThanks for reaching out. We do get a lot of after-hours calls, and most of them aren’t emergencies.\n\nHow does the approval part work? If a resident calls at 11pm about a leak, who decides whether a vendor goes out?\n\nJamie',
 prior:{when:'Nov 3',body:'Hi Jamie,\n\nI’m talking with property managers in Denver about how after-hours maintenance calls get handled. Would a short call be useful?\n\nBest,\nDavid'},
 suggestion:'Hi Jamie,\n\nGood question. Your team sets the rules ahead of time: what counts as urgent and who gets called. Nothing goes to a vendor without a person on your side deciding.\n\nWould 15 minutes next week be useful to walk through how you handle it today?\n\nBest,\nDavid'},
chris:{from:'Chris Lane',email:'chris@lakeshore-res.example',company:'Lakeshore Residential',subject:'Re: After-hours calls at Lakeshore',time:'Nov 2, 3:40 PM',short:'Nov 2',handled:true,
 body:'Not right now, but thanks. Maybe next year.\n\nChris',prior:null,suggestion:''}
};

const TODAY=[
{id:'reply-jamie',kind:'reply',t:'Jamie Ortiz replied',s:'Juniper Residential · “How does the approval part work?”',m:'9:12 AM'},
{id:'callback-maple',kind:'callback',t:'Call back Sam Patel',s:'Maple & Main · asked for after 2 PM their time',m:'2:00 PM'},
{id:'promised-taylor',kind:'promised',key:'taylor',t:'Finish the email you promised Taylor',s:'Alder & Oak Homes · from yesterday’s call',m:'Draft'},
{id:'review-cedar',kind:'decide',t:'Pick Cedar Row’s office number',s:'Two published numbers · one quick decision',m:''},
{id:'calls',kind:'calls',t:'',s:'',m:''}
];
const KIND={reply:['reply','k-reply'],callback:['phone','k-call'],promised:['pen','k-write'],decide:['decide','k-decide'],calls:['prospects','k-call'],nudge:['clock','k-decide'],demo:['cal','k-write']};

const RECIPIENTS=[
{id:'r1',company:'Juniper Residential',person:'Jamie Ortiz',city:'Denver, CO',st:'Replied',chip:'blue',when:'Sent Nov 3'},
{id:'r2',company:'Oakline Rentals',person:'Priya Nair',city:'Charlotte, NC',st:'Sent',chip:'green',when:'Nov 4, 9:05 AM'},
{id:'r3',company:'Prairie Gate Homes',person:'Ben Carter',city:'Wichita, KS',st:'Sent',chip:'green',when:'Today, 10:00 AM'},
{id:'r4',company:'Summit Ridge PM',person:'Elena Ruiz',city:'Albuquerque, NM',st:'Sent',chip:'green',when:'Today, 11:12 AM'},
{id:'r5',company:'Copperleaf Homes',person:'Noah Fischer',city:'Spokane, WA',st:'Waiting',chip:'amber',when:'Their morning window opens at 9 AM'},
{id:'r6',company:'Lakeshore Residential',person:'Chris Lane',city:'Milwaukee, WI',st:'Replied',chip:'blue',when:'Sent Nov 1'}
];

const SLOTS=[
{id:'fri',day:'Friday, Nov 6',short:'Fri, Nov 6',time:'10:00 AM ET',st:'Ready',chip:'green',
 text:'Three property managers told me the same thing this week: most after-hours calls aren’t emergencies, but every one of them still wakes someone up.\n\nThe hard part isn’t answering the phone. It’s deciding, at 11pm, what actually needs a person.\n\nHow does your team draw that line?',from:'Update · “What I heard on calls this week”'},
{id:'mon',day:'Monday, Nov 9',short:'Mon, Nov 9',time:'10:00 AM ET',st:'Upcoming',chip:'',text:'',from:'Drafted the day before from your updates'},
{id:'wed',day:'Wednesday, Nov 11',short:'Wed, Nov 11',time:'10:00 AM ET',st:'Upcoming',chip:'',text:'',from:'Drafted the day before from your updates'},
{id:'wed4',day:'Wednesday, Nov 4',short:'Wed, Nov 4',time:'10:00 AM ET',st:'Skipped',chip:'',text:'',from:'The plan started after this slot, so it was skipped.',past:true},
{id:'mon2',day:'Monday, Nov 2',short:'Mon, Nov 2',time:'10:00 AM ET',st:'Skipped',chip:'',text:'',from:'The plan started after this slot, so it was skipped.',past:true}
];
const DRAFTS=[
{id:'d1',t:'Why I started with property managers',body:'I spent the first month of Callie calling property managers. Here’s what surprised me…',edited:'Nov 3'},
{id:'d2',t:'Comment idea · on a post about vendor scheduling',body:'The part that stood out to me is how often the first call isn’t the real problem.',edited:'Nov 1'}
];
const LIB={
updates:[{id:'u1',t:'What I heard on calls this week',body:'Three managers said most after-hours calls aren’t emergencies. Everyone still gets woken up.',use:true,when:'Nov 4'},{id:'u2',t:'First month of calling',body:'Called ~40 companies. Owners pick up more often than I expected.',use:true,when:'Oct 30'},{id:'u3',t:'Notes from a demo that went badly',body:'Private. Not for posts yet.',use:false,when:'Oct 28'}],
facts:[{id:'f1',t:'Callie is built for residential property managers.',v:2},{id:'f2',t:'David Cui is the founder of Callie.',v:1},{id:'f3',t:'Callie is based in Providence, Rhode Island.',v:1}],
voice:[{id:'v1',t:'Your voice',body:'Plain, specific, first person. Short paragraphs. Ask one real question at the end. No hype words.'}]
};
const CONVOS=[
{id:'c1',who:'A property manager in Ohio',t:'“Our after-hours line is a cell phone that rotates between three of us.”',when:'Observed Nov 3',url:'linkedin.com/posts/example-1'},
{id:'c2',who:'A maintenance vendor in Texas',t:'“Half the emergency calls we get could have waited until morning.”',when:'Observed Oct 30',url:'linkedin.com/posts/example-2'}
];
const RESEARCH_CANDIDATES=[['Brightwater Rentals','Tampa, FL'],['Kestrel Property Group','Reno, NV'],['Old Mill Residential','Lancaster, PA'],['Sagebrush Homes','Tucson, AZ'],['Fernwood Management','Eugene, OR']];

const OUT_MISS=[['no_answer','No answer'],['voicemail_left','Left voicemail'],['busy','Busy'],['wrong_number','Wrong number'],['technical_failure','Call failed']];
const OUT_HIT=[['conversation','Talked'],['interested','Interested'],['callback_requested','Call back later'],['not_interested','Not interested'],['referral_or_wrong_person','Wrong person'],['do_not_call','Do not call']];
const OUT_LABEL=Object.fromEntries([...OUT_MISS,...OUT_HIT]);
const REACHED=new Set(['conversation','interested','callback_requested','not_interested','referral_or_wrong_person']);
const ANNOUNCE='Hi, this is David from Callie. This call is being recorded and transcribed for my notes.';

/* ───────── state ───────── */
const freshCall=()=>({id:null,phase:'idle',t0:0,muted:false,notes:'',outcome:null,cbMode:'unknown',cbDate:'',cbTime:'',dncScope:'contact',dncCh:'phone',promise:false,subj:'',body:'',elsewhere:false,attest:false});
const S={route:'today',today:'reply-jamie',wl:{f:'call',id:'harbor',tab:'brief',q:'',view:'list',drawer:null},em:{f:'replies',id:'jamie'},so:{f:'schedule',id:'fri'},md:false,
 call:freshCall(),done:{},reply:{},pd:{taylor:{co:'alder',to:'taylor@alderoak.example',ctx:'From your call · Nov 4, 4:20 PM',said:'You said you’d send pricing and an example of a weekend call log.',subj:'Pricing and a sample weekend call log',body:'Hi Taylor,\n\nThanks for the time yesterday. As promised, here’s our pricing and an example of what a weekend call log looks like.\n\n[attach or paste details]\n\nBest,\nDavid',saved:false,withdrawn:false}},
 pick:{},theme:'light',states:{expired:false,empty:false,unknown:false},sheet:null,palette:false,pq:'',pi:0,fb:false,hl:null,research:{},fitEdit:false,rhythm:{days:['Mon','Wed','Fri'],time:'10:00 AM'},rhythmEdit:false,planPaused:false,campaignPaused:false,mic:false,calib:{},appearance:'light',lib:{},settingsAt:'account',
 notes:JSON.parse(localStorage.getItem('callie-ws-notes')||'{}'),liked:JSON.parse(localStorage.getItem('callie-ws-liked')||'{}')};
const co=id=>CO[id];
const byStatus=st=>ORDER.filter(id=>CO[id].status===st);
function counts(){return{call:byStatus('call').length,callback:byStatus('callback').length,review:byStatus('review').length,done:byStatus('done').length}}
function nudgeItems(){
 const demos=ORDER.filter(id=>co(id).deal?.stage==='demo'&&co(id).deal.meeting).map(id=>{const c=co(id);return{id:'demo-'+id,kind:'demo',co:id,t:`Get ready for the demo with ${c.first}`,s:`${c.name} · ${c.deal.meeting.replace('Demo · ','')}`,m:'Tue'}});
 const late=ORDER.filter(id=>stuck(id)).map(id=>{const c=co(id);return{id:'nudge-'+id,kind:'nudge',co:id,t:`Nudge ${c.person}`,s:`${c.name} · ${stageName(c.deal.stage)} for ${stuck(id)} days`,m:`$${c.deal.mrr}/mo`}});
 return [...demos,...late];
}
function todayItems(){if(S.states.empty)return[];const base=TODAY.filter(x=>x.kind!=='calls'||counts().call>0),at=base.findIndex(x=>x.kind==='decide'||x.kind==='calls'),n=nudgeItems();return at<0?[...base,...n]:[...base.slice(0,at),...n,...base.slice(at)]}
function openToday(){return todayItems().filter(x=>!S.done[x.id]).length}

/* ───────── routing ───────── */
function hash(){
 const r=S.route;let p;
 if(r==='today')p=['today',S.today];else if(r==='prospects')p=['prospects',S.wl.f,S.wl.id,S.wl.tab];else if(r==='pipeline')p=['pipeline',S.wl.drawer,S.wl.drawer?S.wl.tab:null];else if(r==='email')p=['email',S.em.f,S.em.id];else if(r==='social')p=['social',S.so.f,S.so.id];else p=[r];
 return '#/'+p.filter(Boolean).join('/');
}
function readHash(){
 const p=location.hash.replace(/^#\/?/,'').split('/').filter(Boolean);if(!p.length)return;
 const [r,a,b,c]=p;
 if(r==='today'){S.route='today';if(a)S.today=a}
 else if(r==='pipeline'||r==='prospects'&&a==='board'){const [x,y]=r==='pipeline'?[a,b]:[b,c];S.route='pipeline';S.wl.drawer=x&&CO[x]?x:null;if(S.wl.drawer)S.wl.id=x;if(y)S.wl.tab=y}
 else if(r==='prospects'){S.route='prospects';if(a)S.wl.f=a;if(b&&CO[b])S.wl.id=b;if(c)S.wl.tab=c}
 else if(r==='email'){S.route='email';if(a)S.em.f=a;if(b)S.em.id=b}
 else if(r==='social'){S.route='social';if(a)S.so.f=a;if(b)S.so.id=b}
 else if(['settings','signin'].includes(r))S.route=r;
}

/* ───────── shell ───────── */
const NAV=[['today','Today','today'],['prospects','Prospects','prospects'],['pipeline','Pipeline','board'],['email','Email','mail'],['social','Social','social']];
const pdOpen=()=>Object.values(S.pd).filter(d=>!d.sent&&!d.withdrawn).length;
function navCount(id){if(id==='today')return openToday()||'';if(id==='prospects')return counts().call+counts().callback||'';if(id==='pipeline')return ORDER.filter(stuck).length||'';if(id==='email')return(THREADS.jamie.handled?0:1)+pdOpen()||'';return''}
function shell(){
 if(S.route==='signin')return signinPage();
 const board=S.route==='pipeline',single=S.route==='settings'||board;
 const [list,detail]=S.route==='settings'?['',`<section class="detail" aria-label="Settings">${settingsPage()}</section>`]:board?['',boardPage()]:views[S.route]();
 return `<div class="app">
 <nav class="side" aria-label="Main">
  <div class="brand"><span class="mark">C</span>Callie</div>
  <button class="searchbtn" data-act="palette">${ic('search')}<span style="white-space:nowrap">Search</span><span class="kbd">⌘K</span></button>
  ${NAV.map(([id,l,i])=>`<button class="nav" data-act="go" data-arg="${id}" ${S.route===id?'aria-current="page"':''}>${ic(i)}<span>${l}</span><span class="count">${navCount(id)}</span></button>`).join('')}
  <div class="side-foot">
   <button class="nav" data-act="go" data-arg="settings" ${S.route==='settings'?'aria-current="page"':''}>${ic('settings')}<span>Settings</span></button>
   <div class="me"><span class="av">DC</span><div><div style="font-weight:550;font-size:13px">David Cui</div><div class="faint" style="font-size:12px">Founder workspace</div></div></div>
  </div>
 </nav>
 <div class="mainwrap">
  ${S.states.expired?`<div class="banner" role="status">${ic('clock').replace('<svg','<svg width="16" height="16"')}<span><strong>Your session expired.</strong> Sign in again to keep working. Anything you’ve typed stays on this page.</span><span class="grow"></span><button class="btn smb" data-act="go" data-arg="signin">Sign in again</button></div>`:''}
  <main class="main ${single?'single':''} ${S.md?'show-detail':''}">${list}${detail}</main>
 </div>
 <nav class="tabbar" aria-label="Main">${[...NAV,['settings','Settings','settings']].map(([id,l,i])=>{const n=navCount(id);return `<button data-act="go" data-arg="${id}" ${S.route===id?'aria-current="page"':''}>${ic(i)}<span>${l}</span>${n?`<span class="badge">${n}</span>`:''}</button>`}).join('')}</nav>
 </div>${overlays()}`;
}
const backBtn=()=>`<button class="btn ghost back" data-act="back">${ic('back')} Back</button>`;
function listPane(title,sub,seg,rowsHtml,extra='',foot=''){return `<section class="list" aria-label="${esc(title)} list"><div class="list-head"><h1>${title}</h1>${sub?`<p>${sub}</p>`:''}</div>${seg}${extra}<div class="rows" role="listbox" aria-label="${esc(title)}">${rowsHtml}</div>${foot}</section>`}
function segs(act,cur,items){return `<div class="seg" role="group">${items.map(([id,l,n])=>`<button data-act="${act}" data-arg="${id}" aria-pressed="${cur===id}">${l}${n!==undefined&&n!==''?`<span class="n">${n}</span>`:''}</button>`).join('')}</div>`}
function row({act,arg,sel,ico,cls,t,s,m,done,unread}){return `<button class="row${done?' done':''}" role="option" aria-selected="${!!sel}" data-act="${act}" data-arg="${arg}"><span class="ico ${cls}">${ico}</span><span style="min-width:0"><span class="t">${unread?'<i class="unread"></i>':''}${t}</span><span class="s">${s}</span></span><span class="m">${m||''}</span></button>`}
const detailWrap=(inner,label='Detail')=>`<section class="detail" aria-label="${label}"><div class="page">${inner}</div></section>`;

/* ───────── Today ───────── */
function todayList(){
 const items=todayItems(),open=openToday();
 const rows=items.map(x=>{
  const [i,cls]=KIND[x.kind];
  if(x.kind==='calls'){const c=counts().call,first=co(byStatus('call')[0]);return row({act:'today',arg:x.id,sel:S.today===x.id,ico:ic(i),cls,t:`Make ${c} call${c>1?'s':''}`,s:`${first.name}${c>1?` and ${c-1} more are ready`:' is ready'}`,m:'',done:S.done[x.id]})}
  return row({act:'today',arg:x.id,sel:S.today===x.id,ico:S.done[x.id]?ic('check'):ic(i),cls:S.done[x.id]?'k-done':cls,t:x.t,s:x.s,m:S.done[x.id]?'Done':x.m,done:S.done[x.id]});
 }).join('');
 const bg=`<div class="group">Running on its own</div>
 ${row({act:'jump',arg:'email/campaign/overview',ico:ic('mail'),cls:'k-neutral',t:'Email campaign',s:S.campaignPaused?'Paused':'4 sent · 1 waiting · 2 replies',m:S.campaignPaused?'<span class="chip amber">Paused</span>':'<span class="chip green">On</span>'})}
 ${row({act:'jump',arg:'social/schedule/fri',ico:ic('social'),cls:'k-neutral',t:'LinkedIn posts',s:S.planPaused?'Paused':'Next post Fri 10:00 AM ET',m:S.planPaused?'<span class="chip amber">Paused</span>':'<span class="chip green">On</span>'})}`;
 return listPane('Today','Thursday, November 5',`<div class="seg"><span class="faint sm" style="padding:4px 2px">${open?`${open} thing${open>1?'s':''} need you`:'Nothing needs you right now'}</span></div>`,rows+bg);
}
function todayDetail(){
 const items=todayItems();
 if(!items.length||items.every(x=>S.done[x.id])&&!items.find(x=>x.id===S.today))return detailWrap(clearState());
 const x=items.find(i=>i.id===S.today)||items[0];
 let inner='';
 if(S.done[x.id]&&!['calls','reply','promised'].includes(x.kind))inner=`${backBtn()}<div class="empty"><span class="ico k-call">${ic('check')}</span><h2>Done</h2><p>${esc(x.t)}</p>${nextOpenBtn()}</div>`;
 else if(x.kind==='reply')inner=replyView('jamie','today');
 else if(x.kind==='callback')inner=callbackPreview();
 else if(x.kind==='promised')inner=promisedView(x.key);
 else if(x.kind==='decide')inner=`${backBtn()}<div class="eyebrow">Cedar Row Rentals · Portland, OR</div><h2 class="title">One quick decision</h2><p class="muted" style="margin-top:6px">Once you pick a number, Cedar Row joins your call list.</p><div style="margin-top:18px">${decisionCard('cedar','today')}</div>`;
 else if(x.kind==='nudge')inner=nudgeView(x);
 else if(x.kind==='demo')inner=demoView(x);
 else if(x.kind==='calls')inner=callsPreview();
 return detailWrap(inner);
}
function nudgeView(x){const id=x.co,c=co(id),d=c.deal;return `${backBtn()}<div class="eyebrow">${c.name} · ${c.city}</div><h2 class="title">${stageName(d.stage)} for ${stuck(id)} days</h2><p class="muted" style="margin-top:6px">Most deals move within ${STUCK_DAYS} days. A short check-in keeps it warm.</p>
 <div style="margin-top:18px">${dealCard(id)}</div>
 <div class="sec"><h3>Last activity</h3><ul class="timeline">${c.activity.slice(0,2).map(([w,t,dd])=>`<li><span class="w">${w}</span><span><strong style="font-weight:550">${esc(t)}</strong>${dd?`<span class="d" style="display:block">${esc(dd)}</span>`:''}</span></li>`).join('')}</ul></div>
 <div class="actions"><button class="btn primary" data-act="nudgeemail" data-arg="${id}">${ic('mail')} Write ${c.first} a check-in</button><span class="grow"></span><button class="link" data-act="nudgedone" data-arg="${x.id}">Not now</button></div>`}
function demoView(x){const id=x.co,c=co(id);return `${backBtn()}<div class="eyebrow">${c.name} · ${c.city}</div><h2 class="title">Demo with ${c.person}</h2><div class="meta"><span>${esc(c.deal.meeting.replace('Demo · ',''))}</span><span class="dot"></span><span>${c.role}</span></div>
 <div class="sec"><h3>What you know</h3><ul class="bul">${c.why.map(([t])=>`<li>${esc(t)}</li>`).join('')}${c.activity.filter(a=>a[2]).slice(0,1).map(a=>`<li>${esc(a[2])}</li>`).join('')}</ul></div>
 <div class="sec"><h3>Still unknown</h3><ul class="bul">${c.unknown.map(u=>`<li class="muted">${esc(u)}</li>`).join('')}</ul></div>
 <div class="actions"><button class="btn primary" data-act="jump" data-arg="pipeline/${id}">Open in Pipeline</button><span class="grow"></span><button class="link" data-act="nudgedone" data-arg="${x.id}">Got it</button></div>`}
function clearState(){return `<div class="empty"><span class="ico k-call">${ic('check')}</span><h2>You’re clear for now</h2><p>The email campaign and LinkedIn posts keep running on their own.</p><div class="actions" style="justify-content:center"><button class="btn" data-act="go" data-arg="prospects">Open prospects</button></div></div>`}
function nextOpenBtn(){const n=todayItems().find(i=>!S.done[i.id]);return n?`<div class="actions" style="justify-content:center"><button class="btn primary" data-act="today" data-arg="${n.id}">Next: ${esc(n.kind==='calls'?'Make calls':n.t)} ${ic('arrow')}</button></div>`:''}
function callbackPreview(){const c=co('maple');return `${backBtn()}<div class="eyebrow">${c.name} · ${c.city}</div><h2 class="title">Call back ${c.person}</h2><div class="meta"><span>${c.role}</span><span class="dot"></span><span>${c.local} their time</span><span class="dot"></span><span class="chip amber">${c.callback}</span></div>
 <div class="card soft" style="margin-top:20px"><div class="small-lbl">Last time · Nov 4</div><p style="margin:4px 0 0">“Busy with move-ins this morning, try me after 2.”</p></div>
 <div class="actions"><button class="btn primary big" data-act="jump" data-arg="prospects/callback/maple/brief">${ic('phone')} Open call with Sam</button></div>`}
function callsPreview(){const ids=byStatus('call');return `${backBtn()}<h2 class="title">${ids.length} companies ready to call</h2><p class="muted" style="margin-top:6px">Each one has a person to ask for, a published office line, and a short brief. Call, wrap up, and move to the next.</p>
 <div class="card" style="margin-top:18px;padding:6px 8px">${ids.map(id=>{const c=co(id);return `<div class="row" style="cursor:default"><span class="ico av">${initials(c.name)}</span><span style="min-width:0"><span class="t">${c.name}</span><span class="s">${c.person?`Ask for ${c.person}`:'Ask who handles maintenance'} · ${c.city}</span></span><span class="m">${c.local}</span></div>`}).join('')}</div>
 <div class="actions"><button class="btn primary big" data-act="jump" data-arg="prospects/call/${ids[0]}/brief">${ic('phone')} Start calling</button></div>`}

/* ───────── shared: reply ───────── */
function replyView(tid,ctx){
 const th=THREADS[tid],st=S.reply[tid]||(S.reply[tid]={stage:'write',text:'',sugg:false,prior:false});
 let tail='';
 if(th.handled)tail=`<div class="card soft" style="margin-top:18px"><span class="chip">${ic('check').replace('<svg','<svg width="12" height="12"')} Handled</span><p class="muted" style="margin:8px 0 0">No reply needed.</p></div>`;
 else if(st.stage==='write')tail=`<div class="composer card">
  <div class="composer-h"><strong>Your reply</strong><button class="btn ghost smb" data-act="suggest" data-arg="${tid}">${ic('spark')} Suggest a reply</button></div>
  ${st.sugg?`<div class="sugg"><div class="split"><span class="chip blue">Suggestion</span><span class="sm muted">Based on 2 approved facts. Check it before using.</span></div><div class="sugg-b">${para(th.suggestion)}</div><div class="split"><button class="btn smb" data-act="usesugg" data-arg="${tid}">Use this</button><button class="btn ghost smb" data-act="nosugg" data-arg="${tid}">Dismiss</button></div></div>`:''}
  <textarea rows="7" aria-label="Reply draft" placeholder="Write a personal reply…" data-bind="reply.${tid}.text">${esc(st.text)}</textarea>
  <div class="composer-f"><span class="sm faint">Private. Clears if you refresh.</span><span class="grow"></span><button class="btn primary" data-act="reviewreply" data-arg="${tid}" data-need="reply.${tid}.text" ${st.text.trim()?'':'disabled'}>Review final reply</button></div></div>`;
 else if(st.stage==='sent')tail=`<div class="msg"><div class="msg-h"><strong>You</strong><span>Just now</span><span class="chip green" style="margin-left:auto">${ic('check').replace('<svg','<svg width="12" height="12"')} Sent</span></div><div class="msg-b">${para(st.text)}</div></div><p class="sm faint" style="margin-top:10px">Sent from your Gmail, in the same thread.</p>${S.route==='today'?nextOpenBtn():''}`;
 else tail=`<div class="composer card"><div class="split"><span class="chip green">Final review</span><span class="sm muted">Exactly what ${th.from.split(' ')[0]} will get</span></div>
  <dl class="env"><dt>From</dt><dd>david@example.com</dd><dt>To</dt><dd>${th.email}</dd><dt>Cc</dt><dd class="faint">None</dd><dt>Subject</dt><dd>${esc(th.subject)}</dd></dl>
  <div class="paper">${para(st.text)}</div>
  <div class="composer-f"><button class="btn" data-act="editreply" data-arg="${tid}" ${st.stage==='sending'?'disabled':''}>Edit</button><span class="grow"></span><button class="btn primary" data-act="sendreply" data-arg="${tid}" ${st.stage==='sending'?'disabled':''}>${st.stage==='sending'?'Sending…':`${ic('arrow')} Send`}</button></div>
  <p class="sm faint" style="margin:10px 0 0">Sends from your Gmail, as a reply in the same thread.</p></div>`;
 return `${backBtn()}<div class="eyebrow">${th.company}</div><h2 class="title">${esc(th.subject)}</h2><div class="meta"><span>${th.from}</span><span class="dot"></span><span>${th.email}</span></div>
 ${th.prior?`<div class="msg prior"><div class="msg-h"><strong>You</strong><span>${th.prior.when}</span><button class="link" data-act="prior" data-arg="${tid}">${st.prior?'Hide':'Show your email'}</button></div>${st.prior?`<div class="msg-b">${para(th.prior.body)}</div>`:`<div class="msg-b faint one">${esc(th.prior.body.split('\n\n')[1]||'')}</div>`}</div>`:''}
 <div class="msg"><div class="msg-h"><strong>${th.from}</strong><span>${th.time}</span></div><div class="msg-b">${para(th.body)}</div></div>${tail}`;
}
function promisedView(key){
 const d=S.pd[key],c=co(d.co);
 if(d.withdrawn)return `${backBtn()}<div class="empty"><span class="ico k-neutral">${ic('x')}</span><h2>Withdrawn</h2><p>The private draft was removed. The call record stays.</p>${nextOpenBtn()}</div>`;
 const head=`${backBtn()}<div class="eyebrow">${c.name} · ${c.city}</div><h2 class="title">${d.kind==='checkin'?`Check in with ${c.first}`:`The email you promised ${c.first||c.name}`}</h2>
 ${d.said?`<div class="card soft" style="margin-top:18px"><div class="small-lbl">${d.ctx}</div><p style="margin:4px 0 0">${esc(d.said)}</p></div>`:`<p class="muted" style="margin-top:6px">${d.ctx}</p>`}`;
 if(d.sent)return `${head}<div class="msg" style="margin-top:18px"><div class="msg-h"><strong>You → ${esc(d.to)}</strong><span>Just now</span><span class="chip green" style="margin-left:auto">Sent</span></div><div class="sm faint" style="margin-bottom:8px">${esc(d.subj)}</div><div class="msg-b">${para(d.body)}</div></div>${S.route==='today'?nextOpenBtn():''}`;
 if(d.stage==='review'||d.stage==='sending')return `${head}<div class="composer card"><div class="split"><span class="chip green">Final review</span><span class="sm muted">Exactly what ${c.first||'they'} will get</span></div>
  <dl class="env"><dt>From</dt><dd>david@example.com</dd><dt>To</dt><dd>${esc(d.to)}</dd><dt>Subject</dt><dd>${esc(d.subj)}</dd></dl><div class="paper">${para(d.body)}</div>
  <div class="composer-f"><button class="btn" data-act="editpd" data-arg="${key}" ${d.stage==='sending'?'disabled':''}>Edit</button><span class="grow"></span><button class="btn primary" data-act="sendpd" data-arg="${key}" ${d.stage==='sending'?'disabled':''}>${d.stage==='sending'?'Sending…':`${ic('arrow')} Send`}</button></div>
  <p class="sm faint" style="margin:10px 0 0">Sends from your Gmail as a new email.</p></div>`;
 return `${head}
 <div class="composer card">
  <label class="lbl">To</label><input type="text" aria-label="To" placeholder="Their email address" data-bind="pd.${key}.to" value="${esc(d.to)}">
  <label class="lbl">Subject</label><input type="text" aria-label="Subject" data-bind="pd.${key}.subj" value="${esc(d.subj)}">
  <label class="lbl">Email</label><textarea rows="9" aria-label="Email body" data-bind="pd.${key}.body">${esc(d.body)}</textarea>
  <div class="composer-f">${d.confirm?`<span class="sm" style="color:var(--red)">Withdraw for good?</span><button class="btn smb danger" data-act="withdraw" data-arg="${key}">Withdraw</button><button class="btn smb" data-act="keeppd" data-arg="${key}">Keep</button>`:`<button class="btn ghost danger" data-act="withdraw" data-arg="${key}">Withdraw</button>`}<span class="grow"></span><button class="btn" data-act="savepd" data-arg="${key}">${d.saved?'Saved':'Save draft'}</button><button class="btn primary" data-act="reviewpd" data-arg="${key}" data-need="pd.${key}.to" ${d.to.trim()?'':'disabled'}>Review and send</button></div>
  <p class="sm faint" style="margin:10px 0 0">Private until you send it.</p></div>`;
}
function decisionCard(id,ctx){
 const c=co(id),r=c.review,pick=S.pick[id];
 if(r.kind==='phone')return `<div class="decision"><h3>${r.q}</h3><p class="muted" style="margin:0">${r.why}</p>
  ${r.options.map(o=>`<button class="opt" data-act="pick" data-arg="${id}|${o.v}" aria-pressed="${pick===o.v}"><span class="radio"></span><span><span class="num mono">${o.v}</span><span class="quote" style="display:block;margin-top:6px">“${esc(o.quote)}”</span><span class="sm faint">${o.page}</span></span></button>`).join('')}
  <div class="actions"><button class="btn primary" data-act="decide" data-arg="${id}|${ctx}" ${pick?'':'disabled'}>${pick?`Use ${pick}`:'Choose a number'}</button><button class="btn ghost" data-act="decide-none" data-arg="${id}|${ctx}">Neither works</button></div></div>`;
 return `<div class="decision"><h3>${r.q}</h3><p class="muted" style="margin:0 0 6px">${r.why}</p>
  <div class="quote" style="margin:10px 0">“${esc(c.sources[0].quote)}”<div class="sm faint">${c.sources[0].page}</div></div>
  <div class="actions"><button class="btn primary" data-act="decide" data-arg="${id}|${ctx}|same">Yes, same company</button><button class="btn" data-act="decide-none" data-arg="${id}|${ctx}">No, different</button></div></div>`;
}

/* ───────── Prospects (research + calling) ───────── */
function wlList(){
 const n=counts(),q=S.wl.q.toLowerCase();
 const ids=byStatus(S.wl.f).filter(id=>!q||co(id).name.toLowerCase().includes(q)||(co(id).person||'').toLowerCase().includes(q));
 const rows=ids.map(id=>{const c=co(id);let s,m=c.local;
  if(c.status==='call')s=c.person?`Ask for ${c.person} · ${c.role}`:'Ask who handles maintenance';
  else if(c.status==='callback')s=`${c.person} · ${c.callback}`;
  else if(c.status==='review')s=c.review.kind==='phone'?'Pick the office number':'Confirm the company name';
  else{s=c.deal?`Deal · ${stageName(c.deal.stage)}`:`${c.outcome} · ${c.when}`;m=''}
  return row({act:'wl',arg:id,sel:S.wl.id===id,ico:initials(c.name),cls:'av',t:c.name,s,m,done:c.status==='done'})}).join('')
  ||`<div class="empty" style="padding:40px 10px"><p>${q?'No companies match.':S.wl.f==='call'?'Everyone’s been called. Nice.':'Nothing here.'}</p></div>`;
 return listPane('Prospects','Call, wrap up, move to the next.',segs('wlf',S.wl.f,[['call','To call',n.call],['callback','Callbacks',n.callback],['review','Review',n.review],['done','Done',n.done]]),rows,
  `<label class="filter">${ic('search')}<input type="text" aria-label="Filter companies" placeholder="Filter companies" data-bind="wl.q" data-live="1" value="${esc(S.wl.q)}"></label>`,
  `<div class="list-foot"><button class="btn wide" data-act="sheet" data-arg="research">${ic('plus')} Research more companies</button></div>`);
}
function boardPage(){
 const q=S.wl.q.toLowerCase();
 const match=id=>!q||co(id).name.toLowerCase().includes(q)||(co(id).person||'').toLowerCase().includes(q);
 const lostN=ORDER.filter(id=>colOf(co(id))==='lost').length;
 const cols=COLS.filter(([k])=>k!=='lost'||S.wl.showLost).map(([k,l,clr])=>{const ids=ORDER.filter(id=>colOf(co(id))===k&&match(id));const sum=ids.reduce((s,id)=>s+(co(id).deal?.mrr||0),0);
  return `<section class="col" data-drop="${k}" aria-label="${l}"><div class="col-h"><span class="cdot" style="background:${clr}"></span>${l}<span class="faint">${ids.length}</span></div>${sum&&k!=='lost'?`<div class="col-sum">$${sum.toLocaleString()}/mo</div>`:''}<div class="col-b">${ids.map(kcard).join('')||`<div class="col-empty">${k==='leads'?'Everyone’s been called':'Drop a deal here'}</div>`}${k==='leads'?`<button class="btn ghost smb" data-act="sheet" data-arg="research">${ic('plus')} Research more</button>`:''}</div></section>`}).join('');
 return `<section class="detail boardwrap" aria-label="Pipeline board"><div class="board-h"><div><h1>Pipeline</h1><p>From first call to live customer. Drag a deal to move it.</p></div><span class="grow"></span><button class="btn smb" data-act="showlost" aria-pressed="${!!S.wl.showLost}">${S.wl.showLost?'Hide lost':`Show lost (${lostN})`}</button><label class="filter">${ic('search')}<input type="text" aria-label="Filter companies" placeholder="Filter companies" data-bind="wl.q" data-live="1" value="${esc(S.wl.q)}"></label></div><div class="board">${cols}</div></section>`;
}
function kcard(id){
 const c=co(id),k=colOf(c),d=c.deal,live=S.call.id===id&&S.call.phase!=='idle';
 let sub,foot;
 if(k==='leads'){sub=c.person?`${c.person} · ${c.role}`:'Ask who handles maintenance';foot=c.status==='callback'?`<span class="chip amber">${esc(c.callback)}</span>`:`<span class="faint sm">${c.city} · ${c.local}</span>`}
 else{sub=k==='lost'?d.reason:d.meeting||d.next;const n=stuck(id);foot=`${d.mrr&&k!=='lost'?`<span class="chip green">$${d.mrr}/mo</span>`:''}${n?`<span class="chip amber" title="No movement for ${n} days">${n} days</span>`:''}<span class="faint sm">${c.person?`${esc(c.person)} · `:''}since ${d.since}</span>`}
 return `<div class="kcard${S.wl.drawer===id?' sel':''}" role="button" tabindex="0" draggable="true" data-drag="${id}" data-act="kopen" data-arg="${id}" aria-label="${esc(c.name)}"><span class="kc-t">${live?'<span class="ring" style="margin-right:7px"></span>':''}${c.name}</span><span class="kc-s">${esc(sub)}</span><span class="kc-f">${foot}</span></div>`;
}
function openDeal(id,stage){const c=co(id);c.deal={stage,mrr:0,since:'Today',next:'Decide the next step'};c.activity.unshift(['Today',`Deal opened · ${stageName(stage)}`,''])}
function moveDeal(id,to){const c=co(id);c.activity.unshift(['Today',`Moved to ${stageName(to)}`,`From ${stageName(c.deal.stage)}`]);c.deal.stage=to;c.deal.since='Today'}
function dropTo(id,to){
 const c=co(id);if(!c)return;const from=colOf(c);if(from===to)return render();
 if(S.call.phase!=='idle'&&S.call.id!==id)return toast('Finish the current call first.');
 if(to==='leads')return toast('Deals don’t go back to the call list. Move it to Lost instead.');
 if(from==='leads'&&to==='lost'){S.call={...freshCall(),id,phase:'ended',elsewhere:true,outcome:'not_interested',dropTo:'Closed (no deal)'};S.wl.drawer=id;S.wl.id=id;S.wl.tab='brief';return render()}
 if(to==='lost'){S.wl.drawer=id;S.wl.id=id;S.wl.tab='brief';S.lostAsk={id,reason:null};return render()}
 if(from==='leads'){openDeal(id,to);return toast(`Opened a deal for ${c.name} in ${stageName(to)}.`,()=>{delete c.deal;c.activity.shift()})}
 const prev=c.deal.stage,since=c.deal.since;moveDeal(id,to);toast(`${c.name} moved to ${stageName(to)}.`,()=>{c.deal.stage=prev;c.deal.since=since;c.activity.shift()});
}
function dealCard(id){
 const c=co(id),d=c.deal,i=STAGES.findIndex(x=>x[0]===d.stage);
 if(S.lostAsk?.id===id)return `<div class="decision" style="border-color:var(--red)"><h3>Close ${esc(c.name)} as lost?</h3><p class="muted" style="margin:0 0 10px">What happened? It helps when you look back.</p><div class="choices">${LOST_REASONS.map(r=>`<button class="choice" data-act="lostreason" data-arg="${esc(r)}" aria-pressed="${S.lostAsk.reason===r}">${r}</button>`).join('')}</div><div class="actions"><button class="btn primary" data-act="lostconfirm" ${S.lostAsk.reason?'':'disabled'}>Close as lost</button><button class="btn ghost" data-act="lostcancel">Cancel</button></div></div>`;
 if(d.stage==='lost')return `<div class="card soft"><div class="split"><span class="chip red">Lost</span><span class="muted sm">${esc(d.reason||'')} · ${d.since}</span><span class="grow"></span><button class="btn smb" data-act="reopen" data-arg="${id}">Reopen</button></div></div>`;
 return `<div class="card"><div class="split"><span class="small-lbl">Deal</span><span class="grow"></span>${d.mrr?`<span class="chip green">$${d.mrr}/mo</span>`:'<span class="faint sm">No value yet</span>'}</div>
  <div class="stages" role="group" aria-label="Deal stage">${STAGES.filter(x=>x[0]!=='lost').map(([k,l],j)=>`<button class="stg${j<i?' past':''}" data-act="stage" data-arg="${id}|${k}" aria-pressed="${d.stage===k}" title="${l}">${l}</button>`).join('')}</div>
  ${d.meeting?`<p style="margin:0 0 4px"><strong style="font-weight:600">${esc(d.meeting)}</strong></p>`:''}<p class="sm muted" style="margin:0">Next: ${esc(d.next)}</p>${stuck(id)?`<p class="sm" style="margin:6px 0 0;color:var(--amber)">In ${stageName(d.stage)} for ${stuck(id)} days</p>`:''}
  <div class="actions"><button class="btn" data-act="call" data-arg="${id}">${ic('phone')} Call ${c.first}</button><span class="grow"></span><button class="link" data-act="lost" data-arg="${id}">Close as lost</button></div></div>`;
}
function companyPage(id){
 const c=co(id),tab=S.wl.tab;
 const stChip=c.deal?`<span class="chip ${c.deal.stage==='lost'?'red':'green'}">${stageName(c.deal.stage)}</span>`:c.status==='call'?'<span class="chip green">Ready to call</span>':c.status==='callback'?'<span class="chip amber">Callback</span>':c.status==='review'?'<span class="chip amber">Needs a decision</span>':`<span class="chip">${esc(c.outcome)}</span>`;
 const head=`${backBtn()}<div class="headrow"><div><h2 class="title">${c.name}</h2><div class="meta"><span>${c.city}</span><span class="dot"></span><span>${c.local} local</span><span class="dot"></span><span>${c.kind}</span></div></div>${stChip}</div>`;
 const tabs=`<div class="tabs" role="tablist">${[['brief','Brief'],['sources','Sources',c.sources.length],['activity','Activity']].map(([t,l,n])=>`<button role="tab" aria-selected="${tab===t}" data-act="wltab" data-arg="${t}">${l}${n?`<span class="n">${n}</span>`:''}</button>`).join('')}</div>`;
 const body=tab==='brief'?briefTab(id):tab==='sources'?sourcesTab(id):activityTab(id);
 const live=S.call.id===id&&S.call.phase!=='idle'?callPanel(id):'';
 return head+(live?`<div style="margin-top:18px">${live}</div>`:'')+tabs+body;
}
function wlDetail(){
 const id=S.wl.id;const c=co(id);
 if(!c||!byStatus(S.wl.f).includes(id)&&!(S.call.id===id))return detailWrap(`<div class="empty"><span class="ico k-neutral">${ic('prospects')}</span><h2>Pick a company</h2><p>Choose one from the list to see its brief.</p></div>`);
 return detailWrap(companyPage(id),'Company');
}
function briefTab(id){
 const c=co(id),inCall=S.call.id===id&&S.call.phase!=='idle';
 let top='';
 if(c.deal&&!inCall)top=dealCard(id);
 else if(c.status==='review')top=decisionCard(id,'prospects');
 else if(!inCall&&c.status!=='done')top=`<div class="card callcard">
   <div><div class="small-lbl">Ask for</div><div class="big">${c.person?`${c.person} <span class="faint" style="font-weight:500">· ${c.role}</span>`:'Whoever handles maintenance'}</div></div>
   <div><div class="small-lbl">Office line</div><div class="big mono">${c.phone}<button class="src" data-act="src" data-arg="${c.phoneSrc}" aria-label="Source ${c.phoneSrc}">${c.phoneSrc}</button></div></div>
   <div class="actions"><button class="btn primary big" data-act="call" data-arg="${id}">${ic('phone')} Call${c.first?` ${c.first}`:''}</button><button class="btn" data-act="skip" data-arg="${id}">${ic('skip')} Skip for now</button><span class="grow"></span><button class="link" data-act="elsewhere" data-arg="${id}">Log a call made elsewhere</button></div></div>`;
 else if(c.status==='done'&&!inCall)top=`<div class="card soft"><div class="split"><span class="chip">${esc(c.outcome)}</span><span class="muted sm">${c.when}</span><span class="grow"></span><button class="btn smb" data-act="call" data-arg="${id}">${ic('phone')} Call again</button></div></div>`;
 const why=c.why.map(([t,n])=>`<li>${esc(t)}${n?`<button class="src" data-act="src" data-arg="${n}" aria-label="Source ${n}">${n}</button>`:''}</li>`).join('');
 const fits={supported:['Good fit','green','There are specific reasons to prioritize them'],ordinary:['Typical fit','','Nothing special either way; buying interest unknown'],concern:['Fit concern','red','Something suggests they may not be a fit']};
 const f=fits[c.fit];
 return `${top}
 <div class="sec"><h3>Why them</h3><ul class="bul">${why}</ul></div>
 ${c.unknown.length?`<div class="sec"><h3>Not known yet</h3><ul class="bul">${c.unknown.map(u=>`<li class="muted">${esc(u)}</li>`).join('')}</ul></div>`:''}
 ${c.ask.length?`<div class="sec"><h3>Good openers</h3><ul class="bul q">${c.ask.map(u=>`<li>${esc(u)}</li>`).join('')}</ul></div>`:''}
 <div class="sec"><h3>Fit</h3>${S.fitEdit?`<div class="choices">${Object.entries(fits).map(([k,[l]])=>`<button class="choice" data-act="fit" data-arg="${id}|${k}" aria-pressed="${c.fit===k}">${l}</button>`).join('')}</div><p class="sm faint" style="margin-top:8px">${f[2]}.</p>`:`<div class="split"><span class="chip ${f[1]}">${f[0]}</span><span class="sm muted">${f[2]}</span><button class="link sm" data-act="fitedit">Change</button></div>`}</div>`;
}
function sourcesTab(id){const c=co(id);return c.sources.map(s=>`<div class="card ${S.hl===s.n?'hl':''}" id="src-${s.n}"><div class="split"><span class="src" style="margin:0">${s.n}</span><strong>${esc(s.title)}</strong><span class="faint sm">${s.page}</span></div><p class="quote" style="margin:12px 0">“${esc(s.quote)}”</p><div class="split sm faint"><span>Read on ${s.seen}</span><span>·</span><span>Good until ${s.exp}</span><span class="grow"></span><button class="btn smb" data-act="demo" data-arg="The original page would open in a new tab.">Open page</button></div></div>`).join('')+`<p class="sm faint" style="margin-top:14px">Technical search and extraction details live in <button class="link sm" data-act="jump" data-arg="settings">Settings → Diagnostics</button>.</p>`}
function activityTab(id){const c=co(id);
 const m=c.meeting?`<div class="card" style="margin-bottom:16px"><div class="split"><span class="ico k-write" style="width:24px;height:24px">${ic('chat')}</span><strong>${m_t(c.meeting)}</strong><span class="faint sm">${c.meeting.when}</span></div>
  <div class="sec" style="margin-top:14px"><h3>Before the meeting</h3><ul class="bul q">${c.meeting.prep.map(p=>`<li>${esc(p)}</li>`).join('')}</ul></div>
  <label class="lbl">Notes</label><textarea rows="4" aria-label="Meeting notes" data-bind="meetnotes.${id}">${esc((S.meetnotes||{})[id]??c.meeting.notes)}</textarea>
  <div class="actions"><button class="btn smb primary" data-act="demo" data-arg="Notes saved (prototype only).">Save notes</button></div></div>`:'';
 return `${m}<ul class="timeline">${c.activity.map(([w,t,d])=>`<li><span class="w">${w}</span><span><strong style="font-weight:550">${esc(t)}</strong>${d?`<span class="d" style="display:block">${esc(d)}</span>`:''}</span></li>`).join('')}</ul>`}
const m_t=m=>esc(m.title);
function callPanel(id){
 const c=co(id),k=S.call;
 if(k.phase==='ringing'||k.phase==='connected')return `<div class="live" aria-live="polite">
  <div class="live-top"><span class="ring ${k.phase==='ringing'?'wait':''}"></span><span><span class="who">${c.person||c.name}</span><span class="st" style="display:block">${k.phase==='ringing'?`Calling ${c.phone}…`:`Connected · ${c.phone}`}</span></span><span class="timer" id="calltimer">${k.phase==='connected'?fmt(Date.now()-k.t0):'—'}</span></div>
  <div class="script"><small>Say when they answer</small>${ANNOUNCE}</div>
  <textarea rows="3" aria-label="Call notes" placeholder="Notes while you talk (private)" data-bind="call.notes">${esc(k.notes)}</textarea>
  <div class="actions"><button class="btn lb" data-act="mute" aria-pressed="${k.muted}">${ic('mic')} ${k.muted?'Unmute':'Mute'}</button><span class="grow"></span><button class="btn hang" data-act="hangup">${ic('hang')} End call</button></div></div>`;
 if(S.states.unknown)return `<div class="decision" style="border-color:var(--amber)"><h3>We couldn’t confirm that call was saved</h3><p class="muted">Nothing new will be recorded until this is resolved. Your notes are still here.</p><div class="actions"><button class="btn primary" data-act="unknownfix">Check again</button></div></div>`;
 const reached=REACHED.has(k.outcome);
 const chips=list=>list.map(([v,l])=>`<button class="choice" data-act="outcome" data-arg="${v}" aria-pressed="${k.outcome===v}">${l}</button>`).join('');
 return `<div class="wrap"><div class="split"><h3>${k.elsewhere?'Log a call you made':'How did it go?'}</h3><span class="grow"></span>${k.elsewhere?'':`<span class="faint sm mono">${fmt(k.dur||0)}</span>`}</div>
  ${k.dropTo?`<p class="sm muted" style="margin:4px 0 0">Moving to <strong>${esc(k.dropTo)}</strong>. Confirm what happened and the card moves. Cancel leaves it where it was.</p>`:''}
  <div class="ogroup"><span class="small-lbl">Didn’t reach them</span><div class="choices">${chips(OUT_MISS)}</div></div>
  <div class="ogroup"><span class="small-lbl">Reached someone</span><div class="choices">${chips(OUT_HIT)}</div></div>
  ${k.outcome==='callback_requested'?`<label class="lbl">When should you call back?</label><div class="choices"><button class="choice" data-act="cbmode" data-arg="unknown" aria-pressed="${k.cbMode==='unknown'}">They didn’t say</button><button class="choice" data-act="cbmode" data-arg="time" aria-pressed="${k.cbMode==='time'}">Pick a time</button></div>${k.cbMode==='time'?`<div class="split" style="margin-top:10px"><input type="date" aria-label="Callback date" style="max-width:180px" data-bind="call.cbDate" value="${k.cbDate}"><input type="time" aria-label="Callback time" style="max-width:140px" data-bind="call.cbTime" value="${k.cbTime}"><span class="sm faint">their time (${c.city})</span></div>`:'<p class="sm faint" style="margin:8px 0 0">It’ll show on Today until you call back.</p>'}`:''}
  ${k.outcome==='do_not_call'?`<label class="lbl">What did they ask for?</label><div class="choices"><button class="choice" data-act="dnc" data-arg="scope|contact" aria-pressed="${k.dncScope==='contact'}">Don’t call ${c.first||'this person'}</button><button class="choice" data-act="dnc" data-arg="scope|firm" aria-pressed="${k.dncScope==='firm'}">Don’t call anyone at ${c.name}</button></div><div class="choices" style="margin-top:8px"><button class="choice" data-act="dnc" data-arg="ch|phone" aria-pressed="${k.dncCh==='phone'}">Phone only</button><button class="choice" data-act="dnc" data-arg="ch|all" aria-pressed="${k.dncCh==='all'}">Phone and email</button></div><p class="sm faint" style="margin:8px 0 0">Only pick the broader option if they asked for it.</p>`:''}
  <label class="lbl">Notes</label><textarea rows="3" aria-label="Call notes" placeholder="Private. Never copied into emails." data-bind="call.notes">${esc(k.notes)}</textarea>
  ${reached?`<div style="margin-top:14px"><button class="switch" role="switch" aria-checked="${k.promise}" data-act="promise"><span class="tr"></span>I promised to send an email</button></div>${k.promise?`<label class="lbl">Subject</label><input type="text" aria-label="Promised email subject" data-bind="call.subj" value="${esc(k.subj)}"><label class="lbl">Email</label><textarea rows="5" aria-label="Promised email body" data-bind="call.body" placeholder="Write it now while it’s fresh. You’ll review it on Today.">${esc(k.body)}</textarea>`:''}`:''}
  ${k.elsewhere?`<label class="check"><input type="checkbox" data-bind="call.attest" ${k.attest?'checked':''}> I made this call myself and this is what happened.</label>`:''}
  <div class="actions"><button class="btn primary" data-act="savecall" data-arg="next" ${saveReady()?'':'disabled'} data-gate="call">Save and go to next</button><button class="btn" data-act="savecall" data-arg="stay" ${saveReady()?'':'disabled'} data-gate="call">Save</button><span class="grow"></span><button class="btn ghost" data-act="cancelcall">Cancel</button></div></div>`;
}
function saveReady(){const k=S.call;return !!k.outcome&&(!k.elsewhere||k.attest)&&(!k.promise||(k.subj.trim()&&k.body.trim()))}
const fmt=ms=>{const s=Math.max(0,Math.floor(ms/1000));return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`};

/* ───────── Email ───────── */
function emList(){
 const f=S.em.f;let rows='';
 if(f==='replies')rows=['jamie','chris'].map(t=>{const th=THREADS[t];return row({act:'em',arg:t,sel:S.em.id===t,ico:initials(th.from),cls:'av',t:th.from,s:`${th.company} · ${th.body.split('\n\n')[1]||th.body.split('\n\n')[0]}`,m:th.sent?'Sent':th.handled?'Handled':th.short,unread:!th.handled,done:th.handled})}).join('');
 else if(f==='promised')rows=Object.entries(S.pd).map(([k,d])=>{const c=co(d.co);return row({act:'em',arg:k,sel:S.em.id===k,ico:ic('pen'),cls:d.sent||d.withdrawn?'k-done':'k-write',t:c.person||c.name,s:`${c.name} · ${esc(d.subj)}`,m:d.withdrawn?'Withdrawn':d.sent?'Sent':d.saved?'Saved':'Draft',done:d.sent||d.withdrawn})}).join('');
 else rows=row({act:'em',arg:'overview',sel:S.em.id==='overview',ico:ic('mail'),cls:'k-neutral',t:'Campaign',s:S.campaignPaused?'Paused':'First email to US property managers',m:S.campaignPaused?'<span class="chip amber">Paused</span>':'<span class="chip green">On</span>'})+`<div class="group">Recipients · 6 of 25</div>`+RECIPIENTS.map(r=>row({act:'em',arg:r.id,sel:S.em.id===r.id,ico:initials(r.company),cls:'av',t:r.company,s:`${r.person} · ${r.when}`,m:`<span class="chip ${r.chip}">${r.st}</span>`})).join('');
 return listPane('Email','',segs('emf',f,[['replies','Replies',THREADS.jamie.handled?'':1],['promised','Drafts',pdOpen()||''],['campaign','Campaign']]),rows);
}
function emDetail(){
 const f=S.em.f,id=S.em.id;
 if(f==='replies'&&THREADS[id])return detailWrap(replyView(id,'email'));
 if(f==='promised'&&S.pd[id])return detailWrap(promisedView(id));
 if(f==='campaign'){const r=RECIPIENTS.find(x=>x.id===id);return detailWrap(r?recipientView(r):campaignView())}
 return detailWrap(`<div class="empty"><span class="ico k-neutral">${ic('mail')}</span><h2>Pick a conversation</h2></div>`);
}
function emailPaper(first,company){return `<div class="paper"><div class="sm faint" style="margin-bottom:10px">Subject: After-hours maintenance calls at ${esc(company)}</div>
 <p>Hi ${esc(first)},</p><p>I’m talking with property managers about how after-hours maintenance calls get handled today, and what it costs the team.</p><p>Would a short call be useful?</p>
 <p style="margin-bottom:0">Best,<br>David</p>
 <div class="sig"><span class="wm">Callie</span><div><strong>David Cui</strong><br>Founder<br><span class="faint">usecallie.com</span></div></div>
 <div class="foot">Callie · 100 Example Lane, Example City · Reply “no thanks” and I won’t write again.</div></div>
 <p class="sm faint" style="margin-top:8px">Sample text. The approved template appears here in the real app.</p>`}
function campaignView(){
 const p=S.campaignPaused;
 return `${backBtn()}<div class="headrow"><div><h2 class="title">First-email campaign</h2><div class="meta"><span>US residential property managers</span><span class="dot"></span><span>Started Nov 2</span></div></div>${p?'<span class="chip amber">Paused</span>':'<span class="chip green"><span class="pulse"></span>On</span>'}</div>
 <div class="stats" style="margin-top:22px"><div><b>6<span class="faint" style="font-size:14px;font-weight:500"> / 25</span></b><span>Companies</span></div><div><b>4</b><span>Sent</span></div><div><b>1</b><span>Waiting</span></div><div><b>2</b><span>Replies</span></div><div><b>5</b><span>Daily limit</span></div></div>
 <div class="bar" aria-label="6 of 25 companies"><i style="width:24%"></i></div>
 <div class="sec"><h3>How it runs</h3><ul class="bul"><li>One email per company, to one person whose address has been verified</li><li>At most 5 a day, during each person’s local morning</li><li>No follow-ups. Replies come to you.</li></ul></div>
 <div class="sec"><h3>The email</h3>${emailPaper('Jamie','Juniper')}</div>
 <div class="divider"></div>
 <div class="split"><div class="grow"><strong style="font-weight:550">${p?'Campaign is paused':'Pause the campaign'}</strong><div class="sm muted">${p?'Nothing will be sent until you turn it back on.':'Stops new emails right away. Nothing already sent is affected.'}</div></div><button class="btn ${p?'primary':''}" data-act="campaignpause">${p?'Turn back on':`${ic('pause')} Pause`}</button></div>`;
}
function recipientView(r){return `${backBtn()}<div class="eyebrow">${r.city}</div><div class="headrow"><h2 class="title">${r.company}</h2><span class="chip ${r.chip}">${r.st}</span></div><div class="meta"><span>${r.person}</span></div>
 <ul class="timeline" style="margin-top:18px"><li><span class="w">Picked</span><span>Owner or operator named on their own site</span></li><li><span class="w">Verified</span><span>Email address checked before sending</span></li><li><span class="w">${r.st==='Waiting'?'Next':'Sent'}</span><span>${r.when}</span></li>${r.st==='Replied'?`<li><span class="w">Reply</span><span><button class="link" data-act="jump" data-arg="email/replies/${r.person.startsWith('Jamie')?'jamie':'chris'}">Open the conversation</button></span></li>`:''}</ul>
 <div class="sec"><h3>${r.st==='Waiting'?'What they’ll get':'What they got'}</h3>${emailPaper(r.person.split(' ')[0],r.company.split(' ')[0])}</div>`}

/* ───────── Social ───────── */
function soList(){
 const f=S.so.f;let rows='';
 if(f==='schedule'){rows=SLOTS.filter(s=>!s.past).map(s=>row({act:'so',arg:s.id,sel:S.so.id===s.id,ico:ic('cal'),cls:s.chip?'k-call':'k-neutral',t:s.short,s:s.text?s.text.split('\n')[0]:s.from,m:`<span class="chip ${s.chip}">${S.planPaused&&!s.past?'Paused':s.st}</span>`})).join('')+'<div class="group">Earlier</div>'+SLOTS.filter(s=>s.past).map(s=>row({act:'so',arg:s.id,sel:S.so.id===s.id,ico:ic('cal'),cls:'k-done',t:s.short,s:'Before the plan started',m:'Skipped',done:true})).join('')}
 else if(f==='drafts')rows=DRAFTS.map(d=>row({act:'so',arg:d.id,sel:S.so.id===d.id,ico:ic('pen'),cls:'k-write',t:d.t,s:d.body,m:d.edited})).join('');
 else if(f==='library')rows='<div class="group">Updates</div>'+LIB.updates.map(u=>row({act:'so',arg:u.id,sel:S.so.id===u.id,ico:ic('book'),cls:'k-neutral',t:u.t,s:(S.lib[u.id]??u.use)?'Used for posts':'Private',m:u.when})).join('')+'<div class="group">Approved facts</div>'+LIB.facts.map(x=>row({act:'so',arg:x.id,sel:S.so.id===x.id,ico:ic('check'),cls:'k-call',t:x.t,s:`Approved · version ${x.v}`})).join('')+'<div class="group">Voice</div>'+row({act:'so',arg:'v1',sel:S.so.id==='v1',ico:ic('chat'),cls:'k-violet k-write',t:'Your voice',s:'Style guide · 3 examples reviewed'});
 else rows=CONVOS.map(x=>row({act:'so',arg:x.id,sel:S.so.id===x.id,ico:ic('chat'),cls:'k-neutral',t:x.who,s:x.t,m:x.when.replace('Observed ','')})).join('');
 const foot=f==='drafts'?`<div class="list-foot"><button class="btn wide" data-act="demo" data-arg="A blank private draft would open.">${ic('plus')} New draft</button></div>`:f==='library'?`<div class="list-foot"><button class="btn wide" data-act="demo" data-arg="A blank update would open.">${ic('plus')} Add an update</button></div>`:'';
 return listPane('Social',`LinkedIn · ${S.rhythm.days.join(', ')} at ${S.rhythm.time} ET`,segs('sof',f,[['schedule','Schedule'],['drafts','Drafts',DRAFTS.length],['library','Library'],['conversations','Conversations']]),rows,'',foot);
}
function soDetail(){
 const id=S.so.id,f=S.so.f;
 const slot=SLOTS.find(s=>s.id===id),draft=DRAFTS.find(d=>d.id===id),upd=LIB.updates.find(u=>u.id===id),fact=LIB.facts.find(x=>x.id===id),conv=CONVOS.find(x=>x.id===id);
 if(f==='schedule'&&slot)return detailWrap(slotView(slot));
 if(f==='drafts'&&draft)return detailWrap(`${backBtn()}<div class="eyebrow">Private draft · edited ${draft.edited}</div><h2 class="title">${esc(draft.t)}</h2>
  <div class="composer card"><textarea rows="10" aria-label="Draft" data-bind="sodraft.${id}">${esc((S.sodraft||{})[id]??draft.body)}</textarea><div class="composer-f"><button class="btn ghost" data-act="demo" data-arg="A suggestion would appear, based on your updates and approved facts.">${ic('spark')} Suggest from an update</button><span class="grow"></span><button class="btn" data-act="copy">${ic('copy')} Copy</button><button class="btn primary" data-act="demo" data-arg="Draft saved (prototype only).">Save</button></div>
  <p class="sm faint" style="margin:10px 0 0">Drafts never publish on their own. Scheduled posts come from your plan.</p></div>`);
 if(f==='library'&&upd){const use=S.lib[upd.id]??upd.use;return detailWrap(`${backBtn()}<div class="eyebrow">Update · ${upd.when}</div><h2 class="title">${esc(upd.t)}</h2><div class="composer card"><textarea rows="6" aria-label="Update" data-bind="libtext.${id}">${esc(upd.body)}</textarea>
  <div style="margin-top:14px"><button class="switch" role="switch" aria-checked="${use}" data-act="libuse" data-arg="${upd.id}"><span class="tr"></span>Callie can draft posts from this</button></div><p class="sm faint" style="margin:8px 0 0">${use?'Your plan may turn this into a post.':'Stays private. Never used for posts.'}</p></div>`)}
 if(f==='library'&&fact)return detailWrap(`${backBtn()}<div class="eyebrow">Approved fact · version ${fact.v}</div><h2 class="title">${esc(fact.t)}</h2><p class="muted" style="margin-top:10px">Posts and reply suggestions can state this exactly as written. Editing it creates a new version you’ll need to approve.</p><div class="actions"><button class="btn" data-act="demo" data-arg="An editor for a new version would open.">${ic('pen')} Edit</button></div>`);
 if(f==='library'&&id==='v1')return detailWrap(voiceView());
 if(f==='conversations'&&conv)return detailWrap(`${backBtn()}<div class="eyebrow">${conv.when} · public post</div><h2 class="title">${esc(conv.who)}</h2><div class="post" style="margin-top:18px"><p style="margin:0">${esc(conv.t)}</p></div><p class="sm faint" style="margin-top:12px">A saved copy of a public post. Not a feed, and nothing here is posted or messaged.</p><div class="actions"><button class="btn" data-act="demo" data-arg="The original post would open in a new tab.">Open original</button></div>`);
 return detailWrap(`<div class="empty"><span class="ico k-neutral">${ic('social')}</span><h2>Pick something</h2></div>`);
}
function slotView(s){
 const plan=`<div class="divider"></div><div class="sec" style="margin-top:0"><h3>Your plan</h3>
  ${S.rhythmEdit?`<div class="week">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>`<button class="day" data-act="day" data-arg="${d}" aria-pressed="${S.rhythm.days.includes(d)}">${d}</button>`).join('')}</div><label class="lbl">Time (Eastern)</label><div class="choices">${['8:00 AM','10:00 AM','12:00 PM','4:00 PM'].map(t=>`<button class="choice" data-act="ptime" data-arg="${t}" aria-pressed="${S.rhythm.time===t}">${t}</button>`).join('')}</div><div class="actions"><button class="btn primary" data-act="rhythmdone">Done</button></div>`
  :`<div class="split"><div class="grow"><strong style="font-weight:550">${S.rhythm.days.join(', ')} at ${S.rhythm.time} ET</strong><div class="sm muted">Text posts on your LinkedIn profile, drafted from your updates in your voice.</div></div><button class="btn" data-act="rhythmedit">Change</button><button class="btn ${S.planPaused?'primary':''}" data-act="planpause">${S.planPaused?'Turn back on':`${ic('pause')} Pause`}</button></div>`}</div>`;
 let body;
 if(s.text)body=`<div class="post" style="margin-top:20px"><div class="post-h"><span class="av">DC</span><div><strong>David Cui</strong><small>Founder at Callie · ${s.short}, ${s.time}</small></div></div>${para(s.text)}</div><p class="sm faint" style="margin-top:10px">From: ${s.from}</p>`;
 else body=`<div class="card soft" style="margin-top:20px"><p class="muted" style="margin:0">${s.from}.</p></div>`;
 return `${backBtn()}<div class="headrow"><div><h2 class="title">${s.day}</h2><div class="meta"><span>${s.time}</span><span class="dot"></span><span>LinkedIn · David Cui</span></div></div><span class="chip ${s.chip}">${S.planPaused&&!s.past?'Paused':s.st}</span></div>${body}${s.past?'':plan}`;
}
function voiceView(){const ex=['Most after-hours calls aren’t emergencies. Every one still wakes someone up.','I called 40 property managers this month. Owners pick up more than you’d think.','The hard part isn’t answering the phone. It’s deciding what needs a person.'];
 return `${backBtn()}<div class="eyebrow">Library</div><h2 class="title">Your voice</h2><p class="muted" style="margin-top:8px">${esc(LIB.voice[0].body)}</p>
 <div class="sec"><h3>Does this sound like you?</h3>${ex.map((e,i)=>{const v=S.calib[i];return `<div class="card"><p style="margin:0 0 12px">${esc(e)}</p><div class="choices"><button class="choice" data-act="calib" data-arg="${i}|yes" aria-pressed="${v==='yes'}">Sounds like me</button><button class="choice" data-act="calib" data-arg="${i}|no" aria-pressed="${v==='no'}">Not quite</button></div></div>`}).join('')}</div>
 <div class="actions"><button class="btn" data-act="demo" data-arg="An editor for your style guide would open.">${ic('pen')} Edit style guide</button></div>`}

/* ───────── Settings ───────── */
function settingsPage(){
 const secs=[['account','Account'],['calling','Calling'],['connections','Connections'],['booking','Booking link'],['appearance','Appearance'],['diagnostics','Diagnostics']];
 return `<div class="settings"><nav class="snav" aria-label="Settings sections">${secs.map(([id,l])=>`<button data-act="sjump" data-arg="${id}" aria-current="${S.settingsAt===id}">${l}</button>`).join('')}</nav><div>
 <section class="sblock" id="s-account"><h2>Account</h2><p>Signed in with Google.</p>
  <div class="srow"><span class="av" style="border-radius:50%;background:var(--accent-soft);color:var(--accent)">DC</span><div class="grow"><strong>David Cui</strong><span>david@example.com · Admin · Founder workspace</span></div><button class="btn" data-act="go" data-arg="signin">Sign out</button></div></section>
 <section class="sblock" id="s-calling"><h2>Calling</h2><p>Calls ring from your browser using your computer’s microphone and speakers.</p>
  <div class="srow"><div class="grow"><strong>Calling number</strong><span>(202) 555-0100 · shown to the people you call</span></div><span class="chip green">Ready</span></div>
  <div class="srow"><div class="grow"><strong>Microphone</strong><span>${S.mic?'Speak — the bar should move.':'Check your mic before your first call of the day.'}</span></div>${S.mic?'<span class="meter"><i id="micbar"></i></span>':''}<button class="btn" data-act="mic">${ic('mic')} ${S.mic?'Stop':'Test microphone'}</button></div>
  <div class="srow"><div class="grow"><strong>Test call</strong><span>Call someone who’s expecting it, to check audio both ways.</span></div><button class="btn" data-act="sheet" data-arg="audiotest">Set up a test call</button></div>
  <div class="srow"><div class="grow"><strong>Monthly calling budget</strong><span>$4.12 of $20.00 used this month</span></div><div class="meter" style="width:120px"><i style="width:21%"></i></div></div></section>
 <section class="sblock" id="s-connections"><h2>Connections</h2><p>What Callie can use on your behalf.</p>
  <div class="srow"><span class="ico k-neutral">${ic('mail')}</span><div class="grow"><strong>Google</strong><span>Sign-in, reading replies, and sending the emails you approve</span></div><span class="chip green">Connected</span></div>
  <div class="srow"><span class="ico k-neutral">${ic('social')}</span><div class="grow"><strong>LinkedIn via Buffer</strong><span>David Cui’s profile · verified Nov 5</span></div><span class="chip green">Connected</span><button class="btn ghost danger" data-act="demo" data-arg="Disconnecting would pause your posting plan first.">Disconnect</button></div></section>
 <section class="sblock" id="s-booking"><h2>Booking link</h2><p>Added to emails when someone wants to meet. Doesn’t book anything by itself.</p>
  <div class="split"><input type="url" aria-label="Booking link" value="https://calendar.example/david" style="max-width:380px"><button class="btn" data-act="demo" data-arg="Booking link saved (prototype only).">Save</button></div></section>
 <section class="sblock" id="s-appearance"><h2>Appearance</h2><div class="choices">${['light','dark'].map(t=>`<button class="choice" data-act="theme" data-arg="${t}" aria-pressed="${S.theme===t}">${t==='light'?'Light':'Dark'}</button>`).join('')}</div></section>
 <section class="sblock" id="s-diagnostics"><h2>Diagnostics</h2><p>For troubleshooting. You shouldn’t need this day to day.</p>
  <div class="srow"><div class="grow"><strong>Everything is in sync</strong><span>No pending research, calls, emails or posts need reconciling.</span></div><span class="chip green">0 issues</span></div>
  <div class="sec"><h3>Search and extraction details · Harbor Property Co.</h3>
  <table class="tbl"><thead><tr><th>Page</th><th>Fetched</th><th>Extracted</th><th>Fingerprint</th><th>Expires</th></tr></thead><tbody>
  <tr><td>harbor.example/about</td><td>Oct 28 14:02</td><td>Person, role, region</td><td class="mono">a41f…9c2e</td><td>Jan 26</td></tr>
  <tr><td>harbor.example/contact</td><td>Oct 28 14:02</td><td>Office phone</td><td class="mono">7d0b…11fa</td><td>Jan 26</td></tr></tbody></table></div>
  <div class="actions"><button class="btn" data-act="copy">${ic('copy')} Copy diagnostics</button></div></section>
 </div></div>`;
}
function signinPage(){return `<div class="signin"><div class="card"><div class="brand" style="padding:0 0 18px"><span class="mark">C</span>Callie</div><h2 class="title" style="font-size:20px">Sign in</h2><p class="muted" style="margin-top:4px">Use the Google account your workspace added.</p>
 <label class="lbl" style="margin-top:18px">Workspace</label><input type="text" aria-label="Workspace ID" value="founder-workspace">
 <button class="btn primary big gbtn" data-act="signin">Continue with Google</button>
 <p class="sm faint" style="margin:14px 0 0;text-align:center">Prototype: this returns to the app without signing in.</p></div></div>${overlays()}`}

/* ───────── overlays ───────── */
function overlays(){
 let o='';
 if(S.route==='pipeline'&&S.wl.drawer&&co(S.wl.drawer))o+=`<div class="scrim light" data-act="kclose"></div><aside class="sheet drawer" role="dialog" aria-label="${esc(co(S.wl.drawer).name)}"><div class="sheet-h"><span class="faint sm">Deal</span><button class="btn ghost" data-act="kclose" aria-label="Close">${ic('x')}</button></div><div class="sheet-b">${companyPage(S.wl.drawer)}</div></aside>`;
 if(S.sheet==='research')o+=`<div class="scrim" data-act="closesheet"></div><aside class="sheet" role="dialog" aria-label="Research more companies"><div class="sheet-h"><h2>Research more companies</h2><button class="btn ghost" data-act="closesheet" aria-label="Close">${ic('x')}</button></div>
  <div class="sheet-b"><p class="muted">Callie reads each company’s own website and adds the ones with a named person and an office line to your call list.</p>
  ${RESEARCH_CANDIDATES.map(([n,c],i)=>`<label class="pick"><input type="checkbox" data-bind="research.${i}" ${S.research[i]?'checked':''}><span><strong style="font-weight:550">${n}</strong><span class="sm faint" style="display:block">${c}</span></span><span class="sm faint">Own site found</span></label>`).join('')}</div>
  <div class="sheet-f"><button class="btn" data-act="closesheet">Cancel</button><button class="btn primary" data-act="research" data-gate="research" ${Object.values(S.research).some(Boolean)?'':'disabled'}>Research ${Object.values(S.research).filter(Boolean).length||''} ${Object.values(S.research).filter(Boolean).length===1?'company':'companies'}</button></div></aside>`;
 if(S.sheet==='audiotest')o+=`<div class="scrim" data-act="closesheet"></div><aside class="sheet" role="dialog" aria-label="Test call"><div class="sheet-h"><h2>Test call</h2><button class="btn ghost" data-act="closesheet" aria-label="Close">${ic('x')}</button></div>
  <div class="sheet-b"><p class="muted">Call a friend or teammate who knows it’s a test. Never a prospect.</p><label class="lbl">Their number</label><input type="tel" aria-label="Test number" placeholder="(555) 555-0100"><label class="check"><input type="checkbox"> They know this is a test call.</label></div>
  <div class="sheet-f"><button class="btn" data-act="closesheet">Cancel</button><button class="btn primary" data-act="demo" data-arg="Prototype: no call was placed.">${ic('phone')} Start test call</button></div></aside>`;
 if(S.palette){const opts=paletteOpts();o+=`<div class="scrim" data-act="closepalette"></div><div class="palette" role="dialog" aria-label="Search"><input type="text" id="pq" aria-label="Search" placeholder="Search companies or jump to…" value="${esc(S.pq)}"><div class="opts">${opts.map((x,i)=>`<button class="po ${i===S.pi?'act':''}" data-act="pal" data-arg="${i}">${ic(x[2])}<span>${esc(x[0])}</span><small>${esc(x[3]||'')}</small></button>`).join('')||'<p class="faint" style="padding:10px">No matches</p>'}</div></div>`}
 const key=noteKey(),n=Object.values(S.notes).filter(v=>v&&v.trim()).length;
 o+=`<button class="fbbtn" data-act="fb">${ic('flag').replace('<svg','<svg width="14" height="14"')} Feedback ${n?`<i>${n}</i>`:''}</button>`;
 if(S.fb)o+=`<div class="fb" role="dialog" aria-label="Feedback"><h3>Feedback on this view</h3><p class="sm faint" style="margin:0 0 10px">${esc(key)}</p>
  <textarea rows="4" aria-label="Feedback" placeholder="What feels wrong or right here?" data-bind="notes.${key}" data-store="1">${esc(S.notes[key]||'')}</textarea>
  <div class="split" style="margin-top:8px"><button class="choice" data-act="like" aria-pressed="${!!S.liked[key]}">${S.liked[key]?'Liked':'Like this'}</button><span class="grow"></span><button class="btn smb" data-act="download">Download all</button></div>
  <div class="divider" style="margin:14px 0 10px"></div><div class="small-lbl">Try a state</div><div class="states">
  ${[['expired','Session expired'],['empty','Empty Today'],['unknown','Call not confirmed']].map(([k,l])=>`<button class="choice" data-act="state" data-arg="${k}" aria-pressed="${S.states[k]}">${l}</button>`).join('')}<button class="choice" data-act="go" data-arg="signin">Sign-in page</button><button class="choice" data-act="reset">Reset</button></div>
  <p class="sm faint" style="margin:10px 0 0">Notes stay in this browser. Everything here is fictional; nothing is sent or saved anywhere.</p></div>`;
 if(S.toast)o+=`<div class="toast" role="status">${esc(S.toast)}${S.undo?'<button class="link" data-act="undo">Undo</button>':''}</div>`;
 return o;
}
function noteKey(){if(S.route==='pipeline')return S.wl.drawer?`pipeline/${S.wl.tab}${S.call.phase!=='idle'&&S.call.id===S.wl.id?'/'+S.call.phase:''}`:'pipeline';if(S.route==='prospects')return `prospects/${S.wl.tab}${S.call.phase!=='idle'&&S.call.id===S.wl.id?'/'+S.call.phase:''}`;if(S.route==='today'){const x=todayItems().find(i=>i.id===S.today);return `today/${x?x.kind:''}`}if(S.route==='email')return `email/${S.em.f}`;if(S.route==='social')return `social/${S.so.f}`;return S.route}
function paletteOpts(){
 const q=S.pq.toLowerCase();
 const base=[['Go to Today','go:today','today','G T'],['Go to Prospects','go:prospects','prospects','G P'],['Go to Pipeline','go:pipeline','board',''],['Go to Email','go:email','mail','G E'],['Go to Social','go:social','social','G S'],['Go to Settings','go:settings','settings',''],
  ['Call the next company','next','phone','C'],['Research more companies','research','plus',''],['Switch light / dark','theme','moon','']];
 const cos=ORDER.map(id=>[co(id).name,'co:'+id,'prospects',co(id).city]);
 return [...base,...cos].filter(x=>!q||x[0].toLowerCase().includes(q)||(x[3]||'').toLowerCase().includes(q)).slice(0,9);
}

/* ───────── render ───────── */
const views={today:()=>[todayList(),todayDetail()],prospects:()=>[wlList(),wlDetail()],email:()=>[emList(),emDetail()],social:()=>[soList(),soDetail()]};
let lastKey='';
function render(){
 const key=hash(),det=document.querySelector('.detail'),rows=document.querySelector('.rows');
 const keep=key===lastKey?{d:det?.scrollTop||0,r:rows?.scrollTop||0}:{d:0,r:rows?.scrollTop||0};
 const ae=document.activeElement,aeBind=ae?.dataset?.bind,aeSel=ae&&'selectionStart' in ae?[ae.selectionStart,ae.selectionEnd]:null;
 const sb=document.querySelector('.sheet-b')?.scrollTop||0,bl=document.querySelector('.board')?.scrollLeft||0,cs=[...document.querySelectorAll('.col-b')].map(x=>x.scrollTop);
 document.documentElement.dataset.theme=S.theme;
 document.getElementById('app').innerHTML=shell();
 {const s2=document.querySelector('.sheet-b');if(s2)s2.scrollTop=sb;const b2=document.querySelector('.board');if(b2)b2.scrollLeft=bl;document.querySelectorAll('.col-b').forEach((x,i)=>{x.scrollTop=cs[i]||0})}
 document.title=`${{today:'Today',prospects:'Prospects',pipeline:'Pipeline',email:'Email',social:'Social',settings:'Settings',signin:'Sign in'}[S.route]} — Callie prototype`;
 const d2=document.querySelector('.detail'),r2=document.querySelector('.rows');if(d2)d2.scrollTop=keep.d;if(r2&&S.route+(S.route==='prospects'?S.wl.f:'')===lastRoute)r2.scrollTop=keep.r;
 lastRoute=S.route+(S.route==='prospects'?S.wl.f:'');
 if(location.hash!==key)history.replaceState(null,'',key);lastKey=key;
 if(S.palette){const p=document.getElementById('pq');p.focus();p.setSelectionRange(p.value.length,p.value.length)}
 else if(aeBind){const el=document.querySelector(`[data-bind="${aeBind}"]`);if(el){el.focus();if(aeSel&&'setSelectionRange' in el)try{el.setSelectionRange(...aeSel)}catch{}}}
 if(S.hl){const el=document.getElementById('src-'+S.hl);if(el)el.scrollIntoView({block:'center'});setTimeout(()=>{S.hl=null},1700)}
}
let lastRoute='';
let toastT;function toast(m,undo){S.toast=m;S.undo=undo||null;render();clearTimeout(toastT);toastT=setTimeout(()=>{S.toast=null;S.undo=null;render()},undo?5000:2600)}
function setPath(path,v){const p=path.split('.');let o=S;for(let i=0;i<p.length-1;i++){if(o[p[i]]==null)o[p[i]]={};o=o[p[i]]}o[p[p.length-1]]=v}
function getPath(path){return path.split('.').reduce((o,k)=>o==null?undefined:o[k],S)}

/* ───────── actions ───────── */
function go(r){S.route=r;S.md=false;S.fb=false;if(r==='signin')S.states.expired=false;render()}
function nextCompany(from){const list=byStatus(S.wl.f);const i=list.indexOf(from);return list[i+1]||list[0]||null}
function advanceToday(){const n=todayItems().find(i=>!S.done[i.id]);if(n)S.today=n.id}
const A={
 go:a=>go(a),back:()=>{if(S.route==='pipeline'&&S.wl.drawer)return A.kclose();S.md=false;render()},
 jump:a=>{const [r,x,y,z]=a.split('/');S.route=r;if(r==='prospects'){S.wl.f=x;S.wl.id=y;S.wl.tab=z||'brief'}if(r==='pipeline'){S.wl.drawer=x||null;if(x)S.wl.id=x;S.wl.tab='brief'}if(r==='email'){S.em.f=x;S.em.id=y}if(r==='social'){S.so.f=x;S.so.id=y}S.md=!!x;S.palette=false;render()},
 nudgedone:a=>{S.done[a]=true;advanceToday();render()},
 nudgeemail:a=>{const c=co(a),k='checkin-'+a;if(!S.pd[k])S.pd[k]={co:a,kind:'checkin',to:emailOf(c),ctx:`${stageName(c.deal.stage)} for ${stuck(a)} days. Next step: ${c.deal.next}.`,said:null,subj:`Checking in`,body:`Hi ${c.first},\n\nJust checking in. Is there anything I can answer to help you decide?\n\nBest,\nDavid`,saved:false,withdrawn:false};S.done['nudge-'+a]=true;S.route='email';S.em.f='promised';S.em.id=k;S.md=true;render()},
 sendreply:a=>{const st=S.reply[a];st.stage='sending';render();setTimeout(()=>{st.stage='sent';THREADS[a].handled=true;THREADS[a].sent=true;S.done['reply-jamie']=true;toast(`Sent to ${THREADS[a].from.split(' ')[0]}.`)},900)},
 reviewpd:a=>{const d=S.pd[a];if(!d.subj.trim()||!d.body.trim())return toast('Add a subject and a message first.');d.stage='review';render()},
 editpd:a=>{S.pd[a].stage=null;render()},
 sendpd:a=>{const d=S.pd[a];d.stage='sending';render();setTimeout(()=>{d.stage=null;d.sent=true;S.done['promised-'+a]=true;toast(`Sent to ${d.to}.`)},900)},
 kopen:a=>{if(S.call.phase!=='idle'&&S.call.id!==a)return toast('Finish the current call first.');S.wl.drawer=a;S.wl.id=a;S.wl.tab='brief';S.fitEdit=false;render()},
 kclose:()=>{if(S.call.phase==='ringing'||S.call.phase==='connected')return toast('End the call first.');if(S.call.phase==='ended')S.call=freshCall();S.lostAsk=null;S.wl.drawer=null;render()},
 showlost:()=>{S.wl.showLost=!S.wl.showLost;render()},
 stage:a=>{const [id,k]=a.split('|');const c=co(id),prev=c.deal.stage,since=c.deal.since;if(prev===k)return;moveDeal(id,k);toast(`${c.name} moved to ${stageName(k)}.`,()=>{c.deal.stage=prev;c.deal.since=since;c.activity.shift()})},
 lost:a=>{S.lostAsk={id:a,reason:null};render()},
 lostreason:a=>{S.lostAsk.reason=a;render()},
 lostcancel:()=>{S.lostAsk=null;render()},
 lostconfirm:()=>{const {id,reason}=S.lostAsk,c=co(id),prev=c.deal.stage,since=c.deal.since;moveDeal(id,'lost');c.deal.reason=reason;S.lostAsk=null;toast(`${c.name} closed as lost.`,()=>{c.deal.stage=prev;c.deal.since=since;delete c.deal.reason;c.activity.shift()})},
 reopen:a=>{moveDeal(a,'interested');delete co(a).deal.reason;toast('Reopened in Interested.')},
 undo:()=>{const u=S.undo;S.undo=null;S.toast=null;clearTimeout(toastT);if(u)u();render()},
 today:a=>{S.today=a;S.md=true;render()},
 wl:a=>{S.wl.id=a;S.wl.tab='brief';S.fitEdit=false;S.md=true;render()},
 wlf:a=>{S.wl.f=a;S.wl.id=byStatus(a)[0]||null;S.wl.tab='brief';render()},
 wltab:a=>{S.wl.tab=a;render()},
 src:a=>{S.wl.tab='sources';S.hl=+a;render()},
 fitedit:()=>{S.fitEdit=true;render()},
 fit:a=>{const [id,k]=a.split('|');co(id).fit=k;S.fitEdit=false;render()},
 call:a=>{if(S.call.phase!=='idle'&&S.call.id!==a)return toast('Finish the current call first.');if(S.route!=='prospects'&&S.route!=='pipeline'){S.route='pipeline';S.wl.drawer=a;S.wl.id=a;S.wl.tab='brief'}S.call={...freshCall(),id:a,phase:'ringing'};render();setTimeout(()=>{if(S.call.id===a&&S.call.phase==='ringing'){S.call.phase='connected';S.call.t0=Date.now();render()}},1600)},
 elsewhere:a=>{S.call={...freshCall(),id:a,phase:'ended',elsewhere:true};render()},
 mute:()=>{S.call.muted=!S.call.muted;render()},
 hangup:()=>{S.call.dur=S.call.t0?Date.now()-S.call.t0:0;S.call.phase='ended';render()},
 outcome:a=>{S.call.outcome=a;if(!REACHED.has(a))S.call.promise=false;render()},
 cbmode:a=>{S.call.cbMode=a;render()},
 dnc:a=>{const [k,v]=a.split('|');if(k==='scope')S.call.dncScope=v;else S.call.dncCh=v;render()},
 promise:()=>{S.call.promise=!S.call.promise;render()},
 cancelcall:()=>{S.call=freshCall();render()},
 unknownfix:()=>{S.states.unknown=false;toast('Confirmed. Your last call was saved.')},
 savecall:a=>{const k=S.call,c=co(k.id),id=k.id;const lbl=OUT_LABEL[k.outcome];
  if(k.outcome==='callback_requested'){c.status='callback';c.callback=k.cbMode==='time'&&k.cbDate?`${k.cbDate} ${k.cbTime}`:'Time not set'}else{c.status='done';c.outcome=lbl;c.when='Today'}
  if(k.outcome==='interested'&&!c.deal)openDeal(id,'interested');
  c.activity.unshift(['Today',`Call · ${lbl}`,k.notes]);
  if(k.promise){S.pd[id]={co:id,to:'',ctx:'From today’s call. Add the address they gave you.',said:null,subj:k.subj,body:k.body,saved:false,withdrawn:false};const at=TODAY.findIndex(x=>x.kind==='calls');TODAY.splice(at<0?TODAY.length:at,0,{id:'promised-'+id,kind:'promised',key:id,t:`Finish the email you promised ${c.first||c.name}`,s:`${c.name} · from today’s call`,m:'Draft'})}
  const next=a==='next'?nextCompany(id):null;S.call=freshCall();
  if(S.route==='pipeline'){S.wl.drawer=a==='next'?(byStatus('call').find(x=>x!==id)||null):null;if(S.wl.drawer)S.wl.id=S.wl.drawer}
  else if(next&&next!==id){S.wl.id=next;S.wl.tab='brief'}else if(a==='next'){S.wl.id=byStatus(S.wl.f)[0]||null}
  if(id==='maple')S.done['callback-maple']=true;
  toast(`Saved · ${c.name}: ${lbl}${k.promise?' · the promised email is on Today':''}`)},
 skip:a=>{if(S.route==='pipeline'){S.wl.drawer=null;return toast(`Skipped ${co(a).name} for now.`)}const n=nextCompany(a);if(n&&n!==a){S.wl.id=n;S.wl.tab='brief'}toast(`Skipped ${co(a).name} for now.`)},
 pick:a=>{const [id,v]=a.split('|');S.pick[id]=v;render()},
 decide:a=>{const [id,ctx]=a.split('|');const c=co(id);if(c.review.kind==='phone')c.phone=S.pick[id];c.status='call';if(id==='cedar')S.done['review-cedar']=true;if(ctx==='today')advanceToday();else{S.wl.id=byStatus('review')[0]||null}toast(`${c.name} is now on your call list.`)},
 'decide-none':a=>{const [id,ctx]=a.split('|');const c=co(id);c.status='done';c.outcome='Set aside';c.when='Today';if(id==='cedar')S.done['review-cedar']=true;if(ctx==='today')advanceToday();else S.wl.id=byStatus('review')[0]||null;toast(`${c.name} set aside.`)},
 suggest:a=>{S.reply[a].sugg=true;render()},usesugg:a=>{S.reply[a].text=THREADS[a].suggestion;S.reply[a].sugg=false;render()},nosugg:a=>{S.reply[a].sugg=false;render()},
 reviewreply:a=>{S.reply[a].stage='review';render()},editreply:a=>{S.reply[a].stage='write';render()},
 prior:a=>{S.reply[a].prior=!S.reply[a].prior;render()},
 savepd:a=>{S.pd[a].saved=true;toast('Draft saved.')},
 withdraw:a=>{if(!S.pd[a].confirm){S.pd[a].confirm=true;return render()}S.pd[a].withdrawn=true;S.done['promised-'+a]=true;render()},
 keeppd:a=>{S.pd[a].confirm=false;render()},
 em:a=>{S.em.id=a;S.md=true;render()},emf:a=>{S.em.f=a;S.em.id={replies:'jamie',promised:Object.keys(S.pd)[0],campaign:'overview'}[a];render()},
 campaignpause:()=>{S.campaignPaused=!S.campaignPaused;toast(S.campaignPaused?'Campaign paused (prototype only).':'Campaign back on (prototype only).')},
 so:a=>{S.so.id=a;S.md=true;render()},sof:a=>{S.so.f=a;S.so.id={schedule:'fri',drafts:'d1',library:'u1',conversations:'c1'}[a];render()},
 rhythmedit:()=>{S.rhythmEdit=true;render()},rhythmdone:()=>{S.rhythmEdit=false;toast('Plan updated (prototype only).')},
 day:a=>{const d=S.rhythm.days;S.rhythm.days=d.includes(a)?d.filter(x=>x!==a):['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].filter(x=>x===a||d.includes(x));render()},
 ptime:a=>{S.rhythm.time=a;render()},
 planpause:()=>{S.planPaused=!S.planPaused;toast(S.planPaused?'Posting paused (prototype only).':'Posting back on (prototype only).')},
 libuse:a=>{const u=LIB.updates.find(x=>x.id===a);S.lib[a]=!(S.lib[a]??u.use);render()},
 calib:a=>{const [i,v]=a.split('|');S.calib[i]=v;render()},
 sheet:a=>{S.sheet=a;render()},closesheet:()=>{S.sheet=null;render()},
 research:()=>{const n=Object.values(S.research).filter(Boolean).length;S.sheet=null;S.research={};toast(`Prototype: research for ${n} ${n===1?'company':'companies'} would start. They appear here when ready.`)},
 sjump:a=>{S.settingsAt=a;render();document.getElementById('s-'+a)?.scrollIntoView({behavior:'smooth',block:'start'})},
 theme:a=>{S.theme=a;render()},
 mic:()=>{S.mic=!S.mic;render();if(S.mic)micAnim()},
 signin:()=>{S.route='today';S.states.expired=false;render()},
 palette:()=>{S.palette=true;S.pq='';S.pi=0;render()},closepalette:()=>{S.palette=false;render()},
 pal:a=>runPal(paletteOpts()[+a]),
 fb:()=>{S.fb=!S.fb;render()},
 like:()=>{const k=noteKey();S.liked[k]=!S.liked[k];localStorage.setItem('callie-ws-liked',JSON.stringify(S.liked));render()},
 download:()=>{const blob=new Blob([JSON.stringify({prototype:'callie-single-workspace',exported:new Date().toISOString(),notes:S.notes,liked:S.liked},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='callie-workspace-feedback.json';a.click();URL.revokeObjectURL(a.href)},
 state:a=>{S.states[a]=!S.states[a];if(a==='unknown'&&S.states.unknown){S.route='prospects';S.wl.f='call';S.wl.id=S.wl.id&&co(S.wl.id).status==='call'?S.wl.id:byStatus('call')[0];S.call={...freshCall(),id:S.wl.id,phase:'ended',dur:83000}}if(a==='empty')S.route='today';render()},
 reset:()=>{location.hash='';location.reload()},
 copy:()=>toast('Copied (prototype).'),
 demo:a=>toast(a||'Prototype only.')
};
function runPal(x){if(!x)return;S.palette=false;const [k,v]=x[1].split(':');
 if(k==='go')return go(v);if(k==='co'){const c=co(v);if(c.deal){S.route='pipeline';S.wl.drawer=v;S.wl.id=v;S.wl.tab='brief';return render()}S.route='prospects';S.wl.f=c.status;S.wl.id=v;S.wl.tab='brief';S.md=true;return render()}
 if(k==='next'){const id=byStatus('call')[0];S.route='prospects';S.wl.f='call';S.wl.id=id;S.wl.tab='brief';render();return id&&A.call(id)}
 if(k==='research'){S.route='prospects';S.sheet='research';return render()}
 if(k==='theme'){S.theme=S.theme==='dark'?'light':'dark';return render()}}
function micAnim(){const t=setInterval(()=>{const b=document.getElementById('micbar');if(!S.mic||!b){clearInterval(t);return}b.style.width=(20+Math.random()*70)+'%'},140)}

document.addEventListener('click',e=>{const el=e.target.closest('[data-act]');if(!el||el.disabled)return;const f=A[el.dataset.act];if(f){e.preventDefault();f(el.dataset.arg)}});
document.addEventListener('input',e=>{const el=e.target;if(el.id==='pq'){S.pq=el.value;S.pi=0;render();return}
 const b=el.dataset.bind;if(!b)return;setPath(b,el.type==='checkbox'?el.checked:el.value);
 if(el.dataset.store)localStorage.setItem('callie-ws-notes',JSON.stringify(S.notes));
 if(el.dataset.live||el.type==='checkbox'||b.startsWith('research.'))return render();
 document.querySelectorAll('[data-need]').forEach(x=>{x.disabled=!String(getPath(x.dataset.need)||'').trim()});
 document.querySelectorAll('[data-gate=call]').forEach(x=>{x.disabled=!saveReady()});
});
document.addEventListener('keydown',e=>{
 const typing=/INPUT|TEXTAREA/.test(document.activeElement?.tagName||'');
 if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();S.palette?A.closepalette():A.palette();return}
 if(S.palette){const o=paletteOpts();if(e.key==='Escape')A.closepalette();else if(e.key==='ArrowDown'){e.preventDefault();S.pi=Math.min(o.length-1,S.pi+1);render()}else if(e.key==='ArrowUp'){e.preventDefault();S.pi=Math.max(0,S.pi-1);render()}else if(e.key==='Enter'){e.preventDefault();runPal(o[S.pi])}return}
 if(e.key==='Escape'){if(S.sheet)return A.closesheet();if(S.fb)return A.fb();if(S.route==='pipeline'&&S.wl.drawer)return A.kclose()}
 if(e.key==='Enter'&&document.activeElement?.matches?.('[role=button][data-act]')){e.preventDefault();return document.activeElement.click()}
 if(typing)return;
 if(e.key==='j'||e.key==='k'){const rs=[...document.querySelectorAll('.rows .row[data-act]')];const i=rs.findIndex(r=>r.getAttribute('aria-selected')==='true');const n=rs[Math.max(0,Math.min(rs.length-1,i+(e.key==='j'?1:-1)))];if(n){n.click();setTimeout(()=>document.querySelector('.rows .row[aria-selected=true]')?.scrollIntoView({block:'nearest'}),0)}}
 if(e.key==='c'&&S.route==='prospects'&&S.wl.id&&S.call.phase==='idle'&&['call','callback','done'].includes(co(S.wl.id).status))A.call(S.wl.id);
});
setInterval(()=>{const t=document.getElementById('calltimer');if(t&&S.call.phase==='connected')t.textContent=fmt(Date.now()-S.call.t0)},1000);
let dragId=null;
document.addEventListener('dragstart',e=>{const el=e.target.closest?.('[data-drag]');if(!el)return;dragId=el.dataset.drag;e.dataTransfer.setData('text/plain',dragId);e.dataTransfer.effectAllowed='move';el.classList.add('dragging')});
document.addEventListener('dragend',()=>{dragId=null;document.querySelectorAll('.dragging,.over').forEach(x=>x.classList.remove('dragging','over'))});
document.addEventListener('dragover',e=>{const col=e.target.closest?.('[data-drop]');if(!col||!dragId)return;e.preventDefault();document.querySelectorAll('.col.over').forEach(x=>{if(x!==col)x.classList.remove('over')});col.classList.add('over')});
document.addEventListener('drop',e=>{const col=e.target.closest?.('[data-drop]');if(!col)return;e.preventDefault();const id=e.dataTransfer.getData('text/plain')||dragId;dragId=null;dropTo(id,col.dataset.drop)});
window.addEventListener('hashchange',()=>{if(location.hash!==lastKey){readHash();render()}});
window.CallieWorkspace={S,render,A,dropTo};
readHash();render();
