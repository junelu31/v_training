import { baselineBlendWeight, baselineRelativeScore, blendOverall, describePitchDelta, spectralBalance, scoreBand, validatedOverall } from './voice-metrics.js';
import { baselineReferences, dayOf, driveHistoryExtras, escapeHtml, keepDriveLog, localDayKey, mergeState, normalizeState, selectDrive, shouldPauseForComfort, stableState, streakFromDayKeys, timedWordsFromCloud, trimHistory } from './client-logic.js';
import { phraseDifficulty, orderPracticePhrases } from './drive-coach.js';
import { mountDriveCoach } from './drive-ui.js';
import { readBreathCue, writeBreathCue } from './drive-breath.js';

const STORAGE_KEY = 'lilt.voice.v1';
const DB_NAME = 'lilt-recordings';

const presets = {
  bright: { name: 'Bright femme', short: 'High femme', description: 'Lighter weight, brighter resonance, and expressive movement.', pitch: [190, 245], brightness: [-6, -2], movement: [4, 10], weights: { pitch:.25, brightness:.35, movement:.22, ease:.18 } },
  // Drive's default goal (getGoal). A multi-sentence Aurora sample at speed 0.95
  // measures pitch median ~171.9 Hz and brightness median ~-13.6 dB. Pitch keeps
  // the old 50 Hz width. Brightness [-16, -10] is centered on that median.
  // scoreBand peaks at the midpoint: 185 Hz and -13 dB.
  balanced: { name: 'Balanced femme', short: 'Balanced femme', description: 'A flexible everyday sound matched to Aurora: pitch near 172 Hz, spectral balance near -13 dB, comfortably animated.', pitch: [160, 210], brightness: [-16, -10], movement: [3, 9], weights: { pitch:.25, brightness:.35, movement:.22, ease:.18 } },
  mature: { name: 'Mature & warm', short: 'Mature / warm', description: 'Grounded pitch with a clear, warm resonance and measured melody.', pitch: [155, 205], brightness: [-10, -6], movement: [2, 7], weights: { pitch:.2, brightness:.38, movement:.2, ease:.22 } },
  tomboy: { name: 'Tomboyish femme', short: 'Tomboyish', description: 'Lower, direct, and relaxed while keeping resonance clear and speech light.', pitch: [145, 195], brightness: [-10, -5], movement: [2, 7], weights: { pitch:.15, brightness:.42, movement:.2, ease:.23 } },
  ramona: { name: 'Ramona-inspired', short: 'Ramona-inspired', description: 'Laid-back, dry, and direct; a character-inspired practice direction, not a voice replica.', pitch: [145, 195], brightness: [-10, -5], movement: [2, 7], weights: { pitch:.15, brightness:.42, movement:.2, ease:.23 } }
};

const lessons = window.COURSE_CONTENT.drills;
const courseWeeks = window.COURSE_CONTENT.weeks;

const defaultState = { goal:'balanced', attempts:[], completed:[], saveAudio:false, rate:.88, voice:'', sessionStarted:null, driveLog:[], baselineAttemptId:null, pausedSession:null };
let state = structuredClone(defaultState);
let account = null, stateVersion = 0, syncQueue = Promise.resolve(), syncFailed = false;
let authMode = 'login';
let activeLesson = lessons[0];
let activeActivityId = null;
let mediaStream, audioContext, analyser, sourceNode, recorder, animationFrame, speechRecognition;
let chunks = [], samples = [], currentBlob = null, currentResult = null, transcript = '';
let cloudTranscript = '', wordAnalysis = null;
let analysisStats = { frames:0, audibleFrames:0, peakRms:0 };
let recordingStartedAt = 0;
let recordingDurationSeconds = 0;
let recognitionStatus = { state:'idle', error:null };
let recognitionDone = Promise.resolve();
// Saved non-coach logs still store a planned length of 30. The live session does not end on a timer.
let persistTimer = null;
let playbackUrl = null;
let historyAudioUrl = null;
let adoptBaseline = false;
let takeSaved = false;
const todayKey = localDayKey;

function accountState(raw){
  const next=normalizeState({...structuredClone(defaultState),...(raw&&typeof raw==='object'?raw:{})});
  if(!Array.isArray(next.driveLog))next.driveLog=[];
  if(!Array.isArray(next.attempts))next.attempts=[];
  if(!Array.isArray(next.completed))next.completed=[];
  return next;
}
function loadState(){ try { return accountState(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')); } catch { return accountState({}); } }
function pendingKey(){ return `lilt.pending.${account.id}`; }
function syncMessage(message, failed=false){
  el('syncStatus').textContent=message;
  el('retrySync').hidden=!failed;
  el('loadLatest').hidden=!failed;
}
async function api(path, options={}){
  const response=await fetch(path,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...options.headers}});
  const result=await response.json();
  if(!response.ok){const error=new Error(result.error||'Request failed.');error.status=response.status;throw error}
  return result;
}
function rememberPending(){
  try{localStorage.setItem(pendingKey(),JSON.stringify({state,version:stateVersion}))}catch{syncMessage('Device backup unavailable. Keep this tab open until saved.',true)}
}
async function rebase(){
  const latest=await api('/api/state');
  const server=accountState(latest.state);
  state=trimHistory(mergeState(server,state));
  stateVersion=latest.version||0;
}
function startPersist(){
  persistTimer=null;
  if(!account||syncFailed)return syncQueue;
  syncQueue=syncQueue.then(async()=>{
    if(syncFailed)return;
    const send=async()=>{
      const snapshot=trimHistory(structuredClone(state));
      state=snapshot;
      return {snapshot,result:await api('/api/state',{method:'PUT',body:JSON.stringify({state:snapshot,version:stateVersion})})};
    };
    let sent;
    try{sent=await send()}
    catch(error){
      if(error.status!==409)throw error;
      await rebase();
      sent=await send();
      renderAll();
    }
    stateVersion=sent.result.version;
    if(stableState(trimHistory(state))===stableState(sent.snapshot)){
      localStorage.removeItem(pendingKey());syncMessage('Saved to your account');
    }else{
      rememberPending();
      queueMicrotask(()=>startPersist());
    }
  }).catch(error=>{syncFailed=true;syncMessage(`${error.message} Changes are pending on this device. Export a backup in Settings.`,true)});
  return syncQueue;
}
function persist({immediate=false}={}){
  if(!account)return syncQueue;
  state=trimHistory(state);
  rememberPending();
  if(syncFailed){syncMessage('Changes are pending on this device. Retry saving, or export a backup in Settings.',true);return syncQueue}
  syncMessage('Saving…');
  clearTimeout(persistTimer);
  if(immediate)return startPersist();
  persistTimer=setTimeout(()=>startPersist(),500);
  return syncQueue;
}
function flushPersist(){
  if(persistTimer){clearTimeout(persistTimer);return startPersist()}
  return syncQueue;
}
function exportProgress(value=state){
  const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'}),a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download='lilt-progress.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
async function enterApp(user){
  account=user;
  const saved=await api('/api/state');
  const server=accountState(saved.state);
  state=server;stateVersion=saved.version||0;
  let pending;try{pending=JSON.parse(localStorage.getItem(pendingKey())||'null')}catch{}
  let dirty=false;
  if(pending?.state&&typeof pending.state==='object'){
    state=accountState(trimHistory(mergeState(server,pending.state)));
    dirty=stableState(state)!==stableState(trimHistory(server));
    if(!dirty)localStorage.removeItem(pendingKey());
  }
  init();el('accountEmail').textContent=account.email;
  el('authScreen').hidden=true;el('appShell').hidden=false;
  el('importLocal').hidden=!localStorage.getItem(STORAGE_KEY);
  syncMessage(dirty?'Saving…':'Saved to your account');
  if(dirty)persist({immediate:true});
}
async function startAuth(){
  el('authSubmit').disabled=true;el('authMode').disabled=true;
  el('authMode').onclick=()=>{
    authMode=authMode==='login'?'register':'login';
    el('authTitle').textContent=authMode==='login'?'Welcome back.':'Make room for your voice.';
    el('authSubmit').textContent=authMode==='login'?'Sign in':'Create account';
    el('authMode').textContent=authMode==='login'?'Create an account':'Already have an account? Sign in';
    el('authPassword').autocomplete=authMode==='login'?'current-password':'new-password';
    el('authPassword').minLength=authMode==='register'?12:0;
    el('authEmail').removeAttribute('aria-invalid');el('authPassword').removeAttribute('aria-invalid');
    el('authMessage').classList.remove('form-error');
    el('authMessage').textContent=authMode==='register'?'Choose a password with at least 12 characters.':'';
  };
  for(const id of ['authEmail','authPassword'])el(id).addEventListener('input',()=>el(id).removeAttribute('aria-invalid'));
  el('authForm').onsubmit=async event=>{
    event.preventDefault();
    const email=el('authEmail').value.trim(),password=el('authPassword').value;
    el('authEmail').removeAttribute('aria-invalid');el('authPassword').removeAttribute('aria-invalid');
    if(!email||!el('authEmail').checkValidity())return showAuthError('Enter a valid email address.','authEmail');
    if(!password)return showAuthError('Enter your password.','authPassword');
    if(authMode==='register'&&(password.length<12||password.length>128))return showAuthError('Use a password with 12–128 characters.','authPassword');
    el('authSubmit').disabled=true;el('authMode').disabled=true;
    try{
      const result=await api(`/api/auth/${authMode}`,{method:'POST',body:JSON.stringify({email,password})});
      el('authPassword').value='';await enterApp(result.user);
    }catch(error){showAuthError(error.message)}
    finally{el('authSubmit').disabled=false;el('authMode').disabled=false}
  };
  try{const result=await api('/api/auth/me');await enterApp(result.user)}
  catch(error){el('authMessage').textContent=error.status===401?'':`Cannot reach your account: ${error.message}`}
  finally{el('authSubmit').disabled=false;el('authMode').disabled=false}
}
function el(id){ return document.getElementById(id); }
function showAuthError(message,fieldId){
  el('authMessage').textContent=message;
  el('authMessage').classList.add('form-error');
  if(!fieldId)return;
  el(fieldId).setAttribute('aria-invalid','true');
  el(fieldId).focus();
}
function showMicStatus(message){const status=el('micStatus');if(status)status.textContent=message||''}
function microphoneAvailable(){return !!navigator.mediaDevices?.getUserMedia&&typeof MediaRecorder!=='undefined'}
function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }
function renderAll(){renderGoalOptions();renderToday();renderCourse();renderProgress();renderSettings();renderDrive();updateGoalUI()}
function allCourseSessions(){return courseWeeks.flatMap(week=>week.sessions.map((session,dayIndex)=>({...session,id:`w${week.number}d${dayIndex+1}`,week:week.number,weekTitle:week.title,day:dayIndex+1,activities:session.drills.map((drill,index)=>({id:`w${week.number}d${dayIndex+1}-${index+1}`,drill}))})))}
function activityComplete(id){return state.completed.some(item=>item.activity===id)}
function sessionComplete(session){return session.activities.every(activity=>activityComplete(activity.id))}
function currentCourseSession(){const sessions=allCourseSessions();return sessions.find(session=>!sessionComplete(session))||sessions.at(-1)}
function courseProgress(){const sessions=allCourseSessions(),total=sessions.reduce((sum,s)=>sum+s.activities.length,0),done=sessions.reduce((sum,s)=>sum+s.activities.filter(a=>activityComplete(a.id)).length,0);return {sessions,total,done,percent:total?Math.round(done/total*100):0}}
function activityContext(activityId){for(const session of allCourseSessions()){const index=session.activities.findIndex(a=>a.id===activityId);if(index>=0)return {session,index,activity:session.activities[index]}}return null}
function driveLogs(){return Array.isArray(state.driveLog)?state.driveLog:[]}
function currentDrive(date=new Date()){
  const sessions=allCourseSessions();
  return selectDrive(window.COURSE_CONTENT.drives,{week:currentCourseSession().week,courseComplete:sessions.length>0&&sessions.every(sessionComplete),date});
}
function driveDateLabel(date=new Date()){return date.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'})}
function driveMinutesSince(since){return driveLogs().filter(entry=>new Date(entry.date).getTime()>=since).reduce((sum,entry)=>sum+(entry.actualMinutes||0),0)}

function init(){
  renderGoalOptions(); renderToday(); renderCourse(); renderLibrary('All'); renderProgress(); renderSettings(); renderDrive(); bindEvents();
  const now = new Date(); el('dateLabel').textContent = now.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'}).toUpperCase();
  const hour = now.getHours(); el('timeGreeting').textContent = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  updateGoalUI();
  if(!microphoneAvailable()){showMicStatus('This browser cannot record audio here. Use a current version of Chrome, Edge, or Safari on HTTPS or localhost.');el('recordButton').disabled=true}
}

function renderGoalOptions(){
  el('goalSelect').innerHTML = Object.entries(presets).map(([key,p]) => `<option value="${key}">${p.short}</option>`).join('');
  el('goalSelect').value = state.goal;
}

function renderToday(){
  const session=currentCourseSession(),minutes=session.activities.reduce((sum,a)=>sum+parseInt(lessons.find(l=>l.id===a.drill)?.duration||0),0);
  el('sessionTitle').textContent=`Week ${session.week} · Day ${session.day}: ${session.title}`; el('sessionDuration').textContent=`${minutes} MIN`;
  el('lessonPath').innerHTML = session.activities.map((activity,i)=>{
    const lesson=lessons.find(l=>l.id===activity.drill),done=activityComplete(activity.id),active=!done&&session.activities.slice(0,i).every(a=>activityComplete(a.id));
    return `<article class="lesson-card ${done?'complete':''} ${active?'active-card':''}"><span class="lesson-number">${String(i+1).padStart(2,'0')}</span><span class="status-icon">${done?'✓':active?'▶':'○'}</span><span class="kicker">${lesson.track}</span><h3>${lesson.title}</h3><p>${lesson.duration} · ${lesson.focus}</p><button data-lesson="${lesson.id}" data-activity="${activity.id}" aria-label="Start ${lesson.title}"></button></article>`;
  }).join('');
  const recent = attemptsThisWeek(); const driveMins=driveMinutesSince(Date.now()-7*864e5); const mins=Math.round(recent.reduce((s,a)=>s+(a.duration||0),0)/60)+driveMins;
  el('weekMinutes').textContent=mins; el('weeklyRing').style.background=`conic-gradient(var(--coral) ${clamp(mins/60*360,0,360)}deg,var(--paper-2) 0deg)`;
  el('weeklySummary').textContent = recent.length ? `${recent.length} saved attempt${recent.length===1?'':'s'} · ${mins} min` : driveMins ? `${driveMins} min from drives` : 'No sessions yet';
  const scoreCopy = recent.length ? `${Math.round(recent.reduce((s,a)=>s+a.overall,0)/recent.length)} average score. Notice what feels easier before chasing higher numbers.` : 'Scores show distance to your goal until a baseline snapshot is saved.';
  el('weeklyCopy').textContent = driveMins ? `${scoreCopy} ${driveMins} minutes logged from drives this week.` : scoreCopy;
  renderRestBanner();
  const drive=currentDrive(); el('driveTodayDate').textContent=driveDateLabel(); el('driveTodayTitle').textContent=drive.title; el('driveTodayCopy').textContent=drive.cue;
  el('streakCount').textContent=calculateStreak();
  el('coachNoteTitle').textContent=session.objective;el('coachNoteCopy').textContent=`After this session, ask: ${session.reflection}`;
  document.querySelectorAll('#lessonPath [data-lesson]').forEach(b=>b.onclick=()=>startLesson(b.dataset.lesson,b.dataset.activity));
}

function renderRestBanner(){
  const pause=state.pausedSession, known=pause&&lessons.some(lesson=>lesson.id===pause.lesson);
  const banner=el('restBanner'); if(!banner)return;
  banner.hidden=!known;
  if(!known)return;
  const title=pause.lessonTitle||lessons.find(lesson=>lesson.id===pause.lesson)?.title||'this drill';
  el('restBannerCopy').textContent=`You paused ${title} because comfort was ${pause.comfort} out of 5. Rest, or resume the same drill when your voice feels ready.`;
}
function resumePaused(){
  const pause=state.pausedSession; if(!pause)return;
  startLesson(pause.lesson, pause.activity||null);
}
function dismissPause(){
  state.pausedSession=null; persist(); renderToday();
}
function attemptsThisWeek(){ const since=Date.now()-7*864e5; return state.attempts.filter(a=>new Date(a.date).getTime()>=since); }
function calculateStreak(){return streakFromDayKeys([...state.attempts.map(attempt=>dayOf(attempt.date)),...driveLogs().filter(entry=>entry.actualMinutes>0).map(entry=>dayOf(entry.date))])}

function startLesson(id,activityId=null){
  activeLesson=lessons.find(l=>l.id===id)||lessons[0];
  activeActivityId=activityId;
  el('practiceTrack').textContent=activeLesson.track; el('practiceTitle').textContent=activeLesson.title; el('practiceWhy').textContent=activeLesson.why;
  el('practicePhrase').textContent=`“${activeLesson.phrase}”`; el('practiceCue').textContent=activeLesson.cue; el('stepDuration').textContent=activeLesson.duration.toUpperCase();
  const context=activityId?activityContext(activityId):null;el('stepCount').textContent=context?`STEP ${context.index+1} OF ${context.session.activities.length}`:'OPEN PRACTICE';
  el('ramonaReference').hidden=state.goal!=='ramona';
  el('ramonaReference').querySelector('iframe').src='';
  resetMeters(); showMicStatus(''); showView('practice'); updateGoalUI();
}

function showView(name){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active')); el(`${name}View`).classList.add('active');
  document.querySelectorAll('.nav-item[data-view]').forEach(n=>n.classList.toggle('active',n.dataset.view===name));
  setMenuOpen(false); window.scrollTo({top:0,behavior:'smooth'});
  if(name==='progress') renderProgress(); if(name==='today') renderToday(); if(name==='course')renderCourse(); if(name==='drive')renderDrive();
}

function renderCourse(){
  const progress=courseProgress(); el('courseProgressFill').style.width=`${progress.percent}%`;el('courseProgressText').textContent=`${progress.done} of ${progress.total} activities · ${progress.percent}%`;
  el('courseWeeks').innerHTML=courseWeeks.map(week=>{
    const sessions=progress.sessions.filter(s=>s.week===week.number),done=sessions.filter(sessionComplete).length,current=sessions.some(s=>s.id===currentCourseSession().id);
    return `<article class="course-week ${current?'current':''}"><div class="week-number">${String(week.number).padStart(2,'0')}</div><div class="week-body"><span class="kicker">WEEK ${week.number} · ${done}/5 SESSIONS</span><h2>${week.title}</h2><p>${week.summary}</p><div class="session-list">${sessions.map(session=>{const complete=sessionComplete(session),next=session.id===currentCourseSession().id;return `<button class="session-row ${complete?'complete':''} ${next?'next':''}" data-session="${session.id}"><span>${complete?'✓':`DAY ${session.day}`}</span><b>${session.title}</b><small>${session.objective}</small><i>${complete?'Review':next?'Continue':'Preview'} →</i></button>`}).join('')}</div></div></article>`
  }).join('');
  document.querySelectorAll('[data-session]').forEach(button=>button.onclick=()=>{const session=allCourseSessions().find(s=>s.id===button.dataset.session),activity=session.activities.find(a=>!activityComplete(a.id))||session.activities[0];startLesson(activity.drill,activity.id)});
}

function renderLibrary(filter){
  const libraryLessons=lessons.filter(x=>x.category!=='Drive');
  const cats=['All',...new Set(libraryLessons.map(x=>x.category))];
  el('libraryFilters').innerHTML=cats.map(c=>`<button class="filter-button ${c===filter?'active':''}" data-filter="${c}">${c}</button>`).join('');
  const shown=filter==='All'?libraryLessons:libraryLessons.filter(x=>x.category===filter);
  el('libraryGrid').innerHTML=shown.map((l,i)=>`<article class="library-card"><span class="index">${String(i+1).padStart(2,'0')}</span><span class="kicker">${l.track}</span><h3>${l.title}</h3><p>${l.note}</p><footer><span>${l.duration} · ${l.focus}</span><button class="round-action" data-library-lesson="${l.id}" aria-label="Start lesson">↗</button></footer></article>`).join('');
  document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>renderLibrary(b.dataset.filter));
  document.querySelectorAll('[data-library-lesson]').forEach(b=>b.onclick=()=>startLesson(b.dataset.libraryLesson));
}

function drivePhraseLessons(drive){
  return (drive?.lines||[]).map(id=>lessons.find(item=>item.id===id)).filter(Boolean);
}
function renderDrive(){
  const drive=currentDrive();
  el('driveDate').textContent=driveDateLabel(); el('driveTitle').textContent=drive.title; el('driveCue').textContent=drive.cue;
  const bank=drivePhraseLessons(drive);
  const ordered=orderPracticePhrases(bank.map(lesson=>lesson.phrase));
  el('driveLines').innerHTML=ordered.map((phrase,index)=>{
    const lesson=bank.find(item=>item.phrase===phrase);
    const band=phraseDifficulty(phrase).band;
    const label=band==='easy'?'Easy':band==='medium'?'Medium':'Hard';
    return `<article class="drive-line"><b>Line ${index+1} · ${label} · ${escapeHtml(lesson?.title||'Phrase')}</b><p>“${escapeHtml(phrase)}”</p></article>`;
  }).join('');
  el('driveBlocks').innerHTML=drive.blocks.map((block,index)=>{
    const steps=(block.how||[]).map(step=>`<li>${escapeHtml(step)}</li>`).join('');
    const how=steps?`<details class="drive-how"><summary>How to do this</summary><ol>${steps}</ol></details>`:'';
    return `<article class="settings-card drive-block"><span class="kicker">BLOCK ${index+1} OF ${drive.blocks.length}</span><h2>${escapeHtml(block.title)}</h2><p>${escapeHtml(block.body)}</p>${how}</article>`;
  }).join('');
  el('driveTodayDate').textContent=driveDateLabel(); el('driveTodayTitle').textContent=drive.title; el('driveTodayCopy').textContent=drive.cue;
}
function saveDriveCheckin(){
  const drive=currentDrive(),comfort=+el('driveComfort').value,cueHeld=el('driveCueHeld').value;
  if(!Number.isInteger(comfort)||comfort<1||comfort>5||!['yes','partly','no'].includes(cueHeld)){el('driveCheckinStatus').textContent='Choose comfort and whether the cue held.';return}
  if(!Array.isArray(state.driveLog))state.driveLog=[];
  // plannedMinutes is 30 only because older saved logs require 20, 30, or 40. It is not a session length.
  state.driveLog.push({id:crypto.randomUUID(),date:new Date().toISOString(),routineId:drive.id,plannedMinutes:30,actualMinutes:0,comfort,cueHeld});
  persist({immediate:true}); renderToday(); renderProgress();
  el('driveCheckinStatus').textContent='Saved the check-in. The coach keeps going until you end practice.';
}
function updateGoalUI(){
  const p=presets[state.goal];
  el('goalName').textContent=p.name; el('goalDescription').textContent=p.description;
  const targets=[['Pitch',`${p.pitch[0]}–${p.pitch[1]} Hz`,70],['Brightness','Forward / clear',78],['Movement',`${p.movement[0]}–${p.movement[1]} semitones`,62],['Effort','Easy / sustainable',85]];
  el('targetList').innerHTML=targets.map(t=>`<div class="target-row"><div class="target-label"><span>${t[0]}</span><b>${t[1]}</b></div><div class="target-bar"><i style="width:${t[2]}%"></i></div></div>`).join('');
}

function americanEnglishVoice(voices){
  const candidates=voices.filter(voice=>/^en[-_]US$/i.test(voice.lang));
  return candidates.find(voice=>/google|microsoft|samantha|jenny|aria|ava/i.test(voice.name))||candidates[0]||null;
}
function speakReference(){
  if(!window.speechSynthesis||typeof SpeechSynthesisUtterance==='undefined'){
    el('referenceCaption').textContent='Exact-prompt audio is unavailable in this browser. Try a current version of Chrome, Edge, or Safari with speech enabled.';
    return;
  }
  const utterance=new SpeechSynthesisUtterance(activeLesson.phrase);
  utterance.lang='en-US';utterance.rate=.88;utterance.pitch=1;
  const voices=window.speechSynthesis.getVoices(),voice=americanEnglishVoice(voices);
  if(voice)utterance.voice=voice;
  el('referenceCaption').textContent=voice
    ? `Exact prompt · U.S. English voice (${voice.name}). This is a pronunciation model, not the selected goal voice.`
    : 'Exact prompt · requesting U.S. English from your device. Voice availability and quality depend on your browser and installed voices.';
  window.speechSynthesis.cancel();window.speechSynthesis.speak(utterance);
}
function playRamonaReference(){
  const ramona=el('ramonaReference'),frame=ramona.querySelector('iframe');
  frame.src=`https://www.youtube-nocookie.com/embed/${el('ramonaClipSelect').value}?autoplay=1&rel=0`;
  el('ramonaClipStatus').textContent='Official character inspiration clip. Its dialogue is not the course prompt; use it only to notice relaxed, direct delivery.';
}

async function toggleRecording(){ if(recorder?.state==='recording') stopRecording(); else await startRecording(); }
function micErrorMessage(error){
  return {
    NotAllowedError:'Microphone permission was blocked. Allow it in the address-bar site settings, then try again.',
    NotFoundError:'No microphone was found. Connect one or pick an input in system settings.',
    NotReadableError:'The microphone is in use by another app.',
    SecurityError:'Microphone access needs HTTPS or localhost.'
  }[error?.name]||`Microphone unavailable: ${error?.message||'unknown error'}`;
}
async function startRecording(){
  if(!microphoneAvailable()){
    showMicStatus('This browser cannot record audio here. Use a current version of Chrome, Edge, or Safari on HTTPS or localhost.');
    el('recordButton').disabled=true;
    return;
  }
  showMicStatus('');
  try{
    mediaStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
    audioContext=new (window.AudioContext||window.webkitAudioContext)(); await audioContext.resume(); analyser=audioContext.createAnalyser(); analyser.fftSize=2048; analyser.smoothingTimeConstant=.25;
    sourceNode=audioContext.createMediaStreamSource(mediaStream); sourceNode.connect(analyser); chunks=[];samples=[];transcript='';
    analysisStats={frames:0,audibleFrames:0,peakRms:0}; recordingDurationSeconds=0;
    recorder=new MediaRecorder(mediaStream);
    recorder.onstart=()=>{recordingStartedAt=performance.now()};
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
    recorder.onstop=finishRecording;
    recordingStartedAt=performance.now();
    recorder.start(200);
    startRecognition(); el('recordButton').classList.add('recording'); el('recordButton').querySelector('b').textContent='Stop & analyze'; el('liveChip').style.display='block'; el('visualizerIdle').style.display='none'; drawAndAnalyze();
  }catch(err){
    showMicStatus(micErrorMessage(err));
    mediaStream?.getTracks().forEach(track=>track.stop());
    audioContext?.close();
    mediaStream=null;audioContext=null;recorder=null;
  }
}

function stopRecording(){
  recordingDurationSeconds=Math.max(1,Math.round((performance.now()-recordingStartedAt)/1000));
  if(recorder?.state==='recording') recorder.stop();
  try{ if(recognitionStatus.state==='starting'||recognitionStatus.state==='listening')speechRecognition?.stop?.() }catch{}
  cancelAnimationFrame(animationFrame); mediaStream?.getTracks().forEach(t=>t.stop()); audioContext?.close(); el('recordButton').classList.remove('recording'); el('recordButton').querySelector('b').textContent='Start recording'; el('liveChip').style.display='none';
}

function startRecognition(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){recognitionStatus={state:'unsupported',error:null};recognitionDone=Promise.resolve();return}
  let finish; recognitionDone=new Promise(resolve=>{finish=resolve}); recognitionStatus={state:'starting',error:null};
  try{
    speechRecognition=new SR(); speechRecognition.lang='en-US'; speechRecognition.interimResults=true; speechRecognition.continuous=true;
    speechRecognition.onstart=()=>{recognitionStatus={state:'listening',error:null}};
    speechRecognition.onresult=e=>{transcript=Array.from(e.results).map(r=>r[0].transcript).join(' ').trim();recognitionStatus={state:'listening',error:null}};
    speechRecognition.onerror=e=>{recognitionStatus={state:'error',error:e.error||'unknown'}};
    speechRecognition.onend=()=>{recognitionStatus=transcript?{state:'complete',error:null}:recognitionStatus.state==='error'?recognitionStatus:{state:'empty',error:null};finish()};
    speechRecognition.start();
  }catch(error){recognitionStatus={state:'error',error:error.name||'start-failed'};finish()}
}

function recognitionMessage(){
  if(cloudTranscript)return `Cloud transcript: “${cloudTranscript}”`;
  if(transcript)return `“${transcript.trim()}”${currentResult?.clarity!==null?` · ${currentResult.clarity}% phrase match`:''}`;
  if(recognitionStatus.state==='unsupported')return 'Live transcription is not supported by this browser. Acoustic scoring still works; use a current Chrome or Edge browser for phrase matching.';
  const messages={
    'not-allowed':'The browser blocked speech recognition. Check site microphone permissions and try again.',
    'service-not-allowed':'The browser’s speech-recognition service is disabled or unavailable.',
    'network':'The browser could not reach its speech-recognition service. Check your connection and try again.',
    'audio-capture':'The speech-recognition service could not access the microphone.',
    'no-speech':'The browser received audio but did not return recognizable words.',
    'aborted':'Speech recognition ended before a transcript was returned.'
  };
  if(location.protocol==='file:')return 'Live transcription may not run from a file URL. Start the site on localhost as described in the README, then try again in Chrome or Edge.';
  return messages[recognitionStatus.error]||'The browser did not return a transcript for this take. Acoustic scoring is unaffected.';
}

function drawAndAnalyze(){
  const time=new Float32Array(analyser.fftSize),freq=new Float32Array(analyser.frequencyBinCount); analyser.getFloatTimeDomainData(time); analyser.getFloatFrequencyData(freq);
  const estimate=estimatePitch(time,audioContext.sampleRate), rms=estimate.rms, bright=spectralBalance(freq,audioContext.sampleRate,estimate.hz);
  analysisStats.frames++; analysisStats.peakRms=Math.max(analysisStats.peakRms,rms); if(rms>.003)analysisStats.audibleFrames++;
  if(estimate.hz>=65&&estimate.hz<=550&&estimate.confidence>=.45&&Number.isFinite(bright)) samples.push({pitch:estimate.hz,bright,rms,confidence:estimate.confidence,time:performance.now()});
  updateLiveMeters(); drawWave(time); animationFrame=requestAnimationFrame(drawAndAnalyze);
}

function estimatePitch(buf,sr){
  const mean=buf.reduce((sum,value)=>sum+value,0)/buf.length;
  const centered=new Float32Array(buf.length); let energy=0;
  for(let i=0;i<buf.length;i++){centered[i]=buf[i]-mean;energy+=centered[i]*centered[i]}
  const rms=Math.sqrt(energy/buf.length); if(rms<.003)return {hz:-1,confidence:0,rms};
  const minLag=Math.floor(sr/550),maxLag=Math.min(Math.floor(sr/65),Math.floor(buf.length/2));
  const correlations=new Float32Array(maxLag+1); let bestLag=-1,bestScore=0;
  for(let lag=minLag;lag<=maxLag;lag++){
    let cross=0,left=0,right=0;
    for(let i=0;i<buf.length-lag;i++){const a=centered[i],b=centered[i+lag];cross+=a*b;left+=a*a;right+=b*b}
    const score=left&&right?cross/Math.sqrt(left*right):0; correlations[lag]=score;
    if(score>bestScore){bestScore=score;bestLag=lag}
  }
  if(bestLag<0||bestScore<.45)return {hz:-1,confidence:bestScore,rms};
  const cutoff=Math.max(.45,bestScore*.9);
  for(let lag=minLag+1;lag<maxLag;lag++)if(correlations[lag]>=cutoff&&correlations[lag]>=correlations[lag-1]&&correlations[lag]>=correlations[lag+1]){bestLag=lag;bestScore=correlations[lag];break}
  const before=correlations[bestLag-1]||bestScore,after=correlations[bestLag+1]||bestScore,denom=before-2*bestScore+after;
  const refinedLag=bestLag+(denom?0.5*(before-after)/denom:0);
  return {hz:sr/refinedLag,confidence:bestScore,rms};
}
function median(a){if(!a.length)return 0;const s=[...a].sort((x,y)=>x-y),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2}
function percentile(a,p){if(!a.length)return 0;const s=[...a].sort((x,y)=>x-y);return s[Math.floor((s.length-1)*p)]}
function semitones(low,high){return low>0?12*Math.log2(high/low):0}

function updateLiveMeters(){
  if(!samples.length)return; const recent=samples.slice(-50), pitches=recent.map(s=>s.pitch),brights=recent.map(s=>s.bright);
  const brightness=median(brights); el('pitchValue').textContent=`${Math.round(median(pitches))}`; el('brightnessValue').textContent=`${brightnessLabel(brightness)} ${brightness.toFixed(1)}`; el('movementValue').textContent=`${semitones(percentile(pitches,.1),percentile(pitches,.9)).toFixed(1)} st`;
  const confidence=Math.round(median(recent.map(s=>s.confidence))*100);el('easeValue').textContent=`${confidence}%`;
}
function brightnessLabel(v){return v<-13?'dark':v<-10?'warm':v<-7?'balanced':v<-4?'forward':'bright'}
function drawWave(data){
  const c=el('waveCanvas'),ctx=c.getContext('2d'),w=c.width,h=c.height;ctx.clearRect(0,0,w,h);ctx.fillStyle='#283934';ctx.fillRect(0,0,w,h);ctx.strokeStyle='#ee9278';ctx.lineWidth=2;ctx.beginPath();for(let i=0;i<data.length;i++){const x=i/(data.length-1)*w,y=h/2+data[i]*h*1.8;i?ctx.lineTo(x,y):ctx.moveTo(x,y)}ctx.stroke();ctx.strokeStyle='rgba(255,255,255,.08)';ctx.beginPath();ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();
}

function rangeCoverage(values,range){return values.length?Math.round(values.filter(v=>v>=range[0]&&v<=range[1]).length/values.length*100):0}
function analyzeAttempt(){
  const p=presets[state.goal],pitches=samples.map(s=>s.pitch),brights=samples.map(s=>s.bright),rmsValues=samples.map(s=>s.rms),confidences=samples.map(s=>s.confidence); const pitch=median(pitches),pitchFloor=percentile(pitches,.1),pitchCeiling=percentile(pitches,.9),brightness=median(brights),movement=semitones(pitchFloor,pitchCeiling);
  const pitchCoverage=rangeCoverage(pitches,p.pitch),spectralCoverage=rangeCoverage(brights,p.brightness);
  const pitchScore=scoreBand(pitch,p.pitch,45)*.65+pitchCoverage*.35,brightScore=scoreBand(brightness,p.brightness,6)*.65+spectralCoverage*.35,moveScore=scoreBand(movement,p.movement,5);
  const continuity=clamp(samples.length/Math.max(1,analysisStats.audibleFrames)*100,0,100),confidence=median(confidences),easeScore=clamp((confidence-.4)/.5*65+continuity*.35,0,92);
  const phraseWords=normalize(activeLesson.phrase), heardWords=normalize(transcript); const clarity=heardWords?Math.round(similarity(phraseWords,heardWords)*100):null;
  const first=pitches.slice(0,Math.max(2,Math.floor(pitches.length*.2))),last=pitches.slice(-Math.max(2,Math.floor(pitches.length*.2))),endingShift=12*Math.log2(median(last)/median(first));
  const volumeSpread=20*Math.log10(Math.max(percentile(rmsValues,.75),1e-5)/Math.max(percentile(rmsValues,.25),1e-5)),duration=recordingDurationSeconds||Math.max(1,Math.round((performance.now()-recordingStartedAt)/1000)),pace=heardWords.length?Math.round(heardWords.length/duration*60):null;
  const scores={pitch:Math.round(pitchScore),brightness:Math.round(brightScore),movement:Math.round(moveScore),ease:Math.round(easeScore)};
  const acousticOverall=Math.min(92,Math.round(Object.entries(p.weights).reduce((s,[k,w])=>s+scores[k]*w,0)));
  const raw={pitch:Math.round(pitch),pitchFloor:Math.round(pitchFloor),pitchCeiling:Math.round(pitchCeiling),pitchCoverage,brightness:+brightness.toFixed(1),brightnessCoverage:spectralCoverage,movement:+movement.toFixed(1),continuity:Math.round(continuity),confidence:+confidence.toFixed(2),endingShift:+endingShift.toFixed(1),volumeSpread:+volumeSpread.toFixed(1),pace};
  const ranges={pitch:p.pitch,brightness:p.brightness,movement:p.movement};
  const refs=baselineReferences(state.attempts,{activityId:activeActivityId,lessonId:activeLesson.id});
  const dedicated=baselineAttempt();
  const dedicatedComparison=dedicated?metricComparison(dedicated,raw,ranges,'account'):null;
  const phraseAttempt=refs.phrase&&refs.phrase.id!==dedicated?.id?refs.phrase:null;
  const phraseComparison=phraseAttempt?metricComparison(phraseAttempt,raw,ranges,'phrase'):null;
  const baselineComparison=dedicatedComparison||(refs.phrase?metricComparison(refs.phrase,raw,ranges,'phrase'):null);
  const relative=baselineComparison?.relativeScore;
  const blendedOverall=blendOverall(acousticOverall,relative,practiceWeek());
  return {analysisVersion:5,overall:blendedOverall,acousticOverall,blendedOverall,listenerReview:null,scores,raw,clarity,transcript,duration,baselineComparison,phraseComparison};
}
function practiceWeek(){return activeActivityId?activityContext(activeActivityId)?.session?.week??null:null}
function baselineAttempt(){return state.baselineAttemptId?state.attempts.find(item=>item?.id===state.baselineAttemptId)||null:null}
function metricSnapshot(attempt){
  const raw=attempt?.raw;
  if(!raw||![raw.pitch,raw.brightness,raw.movement].every(Number.isFinite))return null;
  return {pitch:raw.pitch,brightness:raw.brightness,movement:raw.movement};
}
function metricComparison(attempt,raw,ranges,source){
  const snapshot=metricSnapshot(attempt); if(!snapshot)return null;
  const relativeScore=baselineRelativeScore(snapshot,raw,ranges); if(relativeScore==null)return null;
  return {source,id:attempt.id,pitchDelta:Math.round(raw.pitch-snapshot.pitch),brightnessDelta:+(raw.brightness-snapshot.brightness).toFixed(1),movementDelta:+(raw.movement-snapshot.movement).toFixed(1),relativeScore,message:describePitchDelta(raw.pitch-snapshot.pitch,raw.pitch,ranges.pitch)};
}
function signedMeasure(value,unit){const number=+value; if(!Number.isFinite(number))return ''; const rounded=Number.isInteger(number)?number:+number.toFixed(1); return `${rounded>0?'+':''}${rounded} ${unit}`}
function normalize(s){return s.toLowerCase().replace(/[^a-z0-9 ]/g,'').split(/\s+/).filter(Boolean)}
function similarity(a,b){const dp=Array(b.length+1).fill(0);for(let i=1;i<=a.length;i++){let prev=dp[0];dp[0]=i;for(let j=1;j<=b.length;j++){const temp=dp[j];dp[j]=a[i-1]===b[j-1]?prev:1+Math.min(prev,dp[j],dp[j-1]);prev=temp}}return 1-dp[b.length]/Math.max(a.length,b.length,1)}

async function finishRecording(){
  currentBlob=new Blob(chunks,{type:recorder?.mimeType||'audio/webm'});
  if(samples.length<6){
    const quiet=analysisStats.peakRms<.003;
    showMicStatus(quiet?'Not enough microphone signal came through. Check the selected input and its level, then try again.':'The recording was audible, but a stable pitch could not be estimated. Try a slightly longer phrase at a comfortable speaking volume.');
    resetMeters();return
  }
  await Promise.race([recognitionDone,new Promise(resolve=>setTimeout(resolve,1800))]);
  currentResult=analyzeAttempt();
  if(playbackUrl)URL.revokeObjectURL(playbackUrl);
  playbackUrl=URL.createObjectURL(currentBlob);
  el('recordingPlayback').src=playbackUrl;
  renderResults(currentResult); showView('results');
}
function renderResults(r){
  el('overallScore').textContent=r.overall; el('scoreHeadline').textContent=r.overall===100?'Strong targets plus outside feedback':r.overall>=85?'Strong acoustic alignment':r.overall>=70?'A promising working take':r.overall>=50?'Useful information':'Let’s simplify the next take';
  const adjustments=buildAdjustments(r),p=presets[state.goal];el('scoreFeedback').textContent=adjustments[0].summary;
  el('coachAdjustments').innerHTML=adjustments.slice(0,3).map((item,index)=>`<div class="adjustment"><strong>${index+1}. ${item.title}</strong><p>${item.detail}</p></div>`).join('');
  const labels={pitch:['Pitch',`${r.raw.pitch} Hz median · ${r.raw.pitchCoverage}% in ${p.pitch[0]}–${p.pitch[1]} Hz target`],brightness:['Spectral balance',`${r.raw.brightness} dB pitch-aware proxy · ${r.raw.brightnessCoverage}% of voiced frames in target`],movement:['Movement',`${r.raw.movement} semitone 10–90% range · target ${p.movement[0]}–${p.movement[1]}`],ease:['Signal control',`${r.raw.continuity}% voiced continuity · ${Math.round(r.raw.confidence*100)}% pitch confidence`]};
  const observations=[['Pitch floor',`${r.raw.pitchFloor} Hz`,r.raw.pitchFloor<p.pitch[0]?'Below target floor':'Within/above target floor'],['Pitch ceiling',`${r.raw.pitchCeiling} Hz`,'90th percentile'],['Phrase ending',`${r.raw.endingShift>0?'+':''}${r.raw.endingShift} st`,'Last fifth versus first fifth'],['Volume variation',`${r.raw.volumeSpread} dB`,'Informational; microphone-dependent'],['Clarity',r.clarity===null?'Not available':`${r.clarity}%`,r.clarity===null?'Browser transcript unavailable':'Phrase-word match'],['Pace',r.raw.pace===null?'Not available':`${r.raw.pace} wpm`,'Informational, not gender-scored']];
  el('scoreBreakdown').innerHTML=Object.entries(r.scores).map(([k,v])=>`<div class="breakdown-row"><div class="breakdown-label"><span>${labels[k][0]}</span><b>${v}</b></div><div class="breakdown-bar"><i style="width:${v}%"></i></div><p>${labels[k][1]}</p></div>`).join('')+`<div class="observation-grid">${observations.map(o=>`<div class="observation"><span>${o[0]}</span><strong>${o[1]}</strong><small>${o[2]}</small></div>`).join('')}</div>`;
  el('comfortRating').value=3;el('alignmentRating').value=3;el('comfortOutput').textContent='3 / 5';el('alignmentOutput').textContent='3 / 5';el('listenerReview').value='';
  adoptBaseline=false; takeSaved=false; el('restPanel').hidden=true; el('saveContinueButton').disabled=false; el('continueAnyway').disabled=false;
  renderBaselineCopy(); refreshComfortCue();
  cloudTranscript='';wordAnalysis=null;
  el('cloudAnalyzeButton').hidden=!activeActivityId;el('cloudAnalysisNote').hidden=!activeActivityId;
  el('cloudAnalyzeButton').disabled=false;el('cloudAnalyzeButton').textContent='Analyze words with Workers AI';el('wordAnalysisStatus').textContent='';el('wordFindings').innerHTML='';
  el('transcriptText').textContent=recognitionMessage();
}
function scoreHeadline(overall){return overall===100?'Strong targets plus outside feedback':overall>=85?'Strong acoustic alignment':overall>=70?'A promising working take':overall>=50?'Useful information':'Let’s simplify the next take'}
function renderBaselineCopy(){
  const note=el('baselineNote'); if(!note||!currentResult)return;
  const comparison=currentResult.baselineComparison;
  if(!comparison){
    note.textContent=activeLesson.id==='baseline'&&!state.baselineAttemptId
      ?'This is a starting snapshot. A comfortable save becomes your baseline, and later scores show change from it. Right now the number is only distance to the goal band.'
      :'There is no baseline yet, so this number is only distance to the goal band. Save the Natural voice snapshot, or use this take as your baseline.';
    return;
  }
  const source=comparison.source==='account'?'your natural-voice baseline':'your first take of this phrase';
  const phrase=currentResult.phraseComparison&&currentResult.phraseComparison.id!==comparison.id?` This phrase’s first take: ${currentResult.phraseComparison.message}.`:'';
  note.textContent=`${comparison.message}. Brightness ${signedMeasure(comparison.brightnessDelta,'dB')} and movement ${signedMeasure(comparison.movementDelta,'st')} versus ${source}.${phrase}${baselineComfortLine()}`;
}
function baselineComfortLine(){
  const id=currentResult?.baselineComparison?.id, reference=state.attempts.find(item=>item.id===id);
  if(!Number.isFinite(reference?.comfort))return '';
  const comfort=+el('comfortRating').value, delta=comfort-reference.comfort;
  const change=delta>0?`${delta} higher than`:delta<0?`${Math.abs(delta)} lower than`:'the same as';
  return ` Comfort is ${change} that snapshot (${comfort}/5 now, ${reference.comfort}/5 then).`;
}
function refreshComfortCue(){
  const comfort=+el('comfortRating').value;
  const lines=[];
  if(shouldPauseForComfort(comfort))lines.push('You rated this uncomfortable. Saving will pause here so you can rest, instead of starting the next drill.');
  if((currentResult?.acousticOverall??0)>=70&&shouldPauseForComfort(comfort))lines.push('You rated this uncomfortable. The acoustic score does not outvote your throat.');
  el('comfortNotice').textContent=lines.join(' ');
  el('saveContinueButton').textContent=shouldPauseForComfort(comfort)?'Save and rest':'Save & continue';
  const button=el('baselineButton');
  button.setAttribute('aria-pressed',adoptBaseline?'true':'false');
  button.textContent=adoptBaseline?'This take will be your baseline':state.baselineAttemptId?'Update my baseline':'Use this take as my baseline';
  renderBaselineCopy();
  writeScoreEvidence();
}
function writeScoreEvidence(){
  if(!currentResult)return;
  if(currentResult.overall===100){el('scoreEvidence').textContent='All measured dimensions are strong and you reported consistent target perception from at least three unfamiliar listeners. This is supporting evidence, not a guarantee for every listener, context, or day.';return}
  const band=`Acoustic alignment: ${currentResult.acousticOverall}/92. A score of 100 is reserved for near-top acoustic results plus consistent independent listener feedback; the app cannot determine passing by itself.`;
  if(!currentResult.baselineComparison){el('scoreEvidence').textContent=`No baseline yet, so the overall number is only distance to the goal band. ${band}`;return}
  const weight=Math.round(baselineBlendWeight(practiceWeek())*100);
  el('scoreEvidence').textContent=`The overall blends the goal band with change from your baseline (${weight}% of this score is that change). ${band}`;
}
function updateValidatedScore(){
  if(!currentResult)return;
  currentResult.listenerReview=el('listenerReview').value||null;
  const validated=validatedOverall(currentResult.acousticOverall,currentResult.scores,{pitch:currentResult.raw.pitchCoverage,spectral:currentResult.raw.brightnessCoverage},currentResult.clarity,currentResult.listenerReview);
  currentResult.overall=validated===100?100:(currentResult.blendedOverall??currentResult.acousticOverall);
  el('overallScore').textContent=currentResult.overall;
  el('scoreHeadline').textContent=scoreHeadline(currentResult.overall);
  writeScoreEvidence();
}

async function analyzeWordsWithCloud(){
  if(!currentBlob||!activeActivityId)return;
  if(currentResult?.duration>120){el('wordAnalysisStatus').textContent='For this course analysis, keep the recording under two minutes and try again.';return}
  const button=el('cloudAnalyzeButton');button.disabled=true;el('wordAnalysisStatus').textContent='Sending this take to Cloudflare Workers AI for transcription…';
  try{
    const promptBytes=new TextEncoder().encode(activeLesson.phrase);let promptBinary='';for(const byte of promptBytes)promptBinary+=String.fromCharCode(byte);
    let response;
    try{
      response=await fetch('/api/analyze',{method:'POST',credentials:'same-origin',headers:{'Content-Type':currentBlob.type||'audio/webm','X-Practice-Prompt':btoa(promptBinary)},body:currentBlob});
    }catch(error){
      throw new Error(`Could not reach this site's transcription endpoint (${error.message||'network request failed'}). Check your connection or sign-in, then retry.`);
    }
    const result=await response.json().catch(()=>({error:`The server returned an unreadable response (HTTP ${response.status}).`}));
    if(!response.ok)throw new Error(result.error||`Cloud transcription failed (HTTP ${response.status}).`);
    cloudTranscript=String(result.text||'').trim();
    el('transcriptText').textContent=recognitionMessage();
    const timedWords=timedWordsFromCloud(result);
    wordAnalysis=buildWordAnalysis(activeLesson.phrase,cloudTranscript,timedWords);
    currentResult.wordAnalysis=wordAnalysis?.findings||[];
    renderWordAnalysis(wordAnalysis);
    el('wordAnalysisStatus').textContent=wordAnalysis?.status||'Cloud transcription completed, but word timing could not be aligned confidently.';
  }catch(error){
    el('wordAnalysisStatus').textContent=`Workers AI analysis could not complete: ${error.message}. Your local acoustic score is still available.`;
  }finally{button.disabled=false;button.textContent='Analyze again with Workers AI'}
}
function buildWordAnalysis(prompt,cloudText,chunks){
  const expected=normalize(prompt),cloudTokens=normalize(cloudText);
  if(!cloudTokens.length||!chunks.length)return {status:'Cloud transcription succeeded, but timestamped segments were not returned, so word-level locations are unavailable.',findings:[]};
  const promptMatch=similarity(expected,cloudTokens);
  if(promptMatch<.68)return {status:`The cloud transcript differed too much from the course prompt to trust word locations (${Math.round(promptMatch*100)}% agreement). The transcript is shown for review; word corrections are hidden.`,findings:[]};
  const timed=[];
  for(const chunk of chunks){
    const words=normalize(chunk.text),stamp=chunk.timestamp||[];if(!words.length||!Number.isFinite(stamp[0])||!Number.isFinite(stamp[1])||stamp[1]<=stamp[0])continue;
    words.forEach((word,index)=>timed.push({word,start:stamp[0]+(stamp[1]-stamp[0])*index/words.length,end:stamp[0]+(stamp[1]-stamp[0])*(index+1)/words.length,approximate:words.length>1}));
  }
  const pairs=alignWords(expected,timed.map(item=>item.word)),findings=[];
  for(const [expectedIndex,timedIndex] of pairs){
    const token=timed[timedIndex];if(!token||token.word!==expected[expectedIndex])continue;
    const voiceFrames=samples.filter(sample=>{const t=(sample.time-recordingStartedAt)/1000;return t>=token.start&&t<=token.end});
    const p=presets[state.goal],pitch=voiceFrames.length?median(voiceFrames.map(s=>s.pitch)):null,brightness=voiceFrames.length?median(voiceFrames.map(s=>s.bright)):null;
    const enough=voiceFrames.length>=4,dark=brightness!==null&&brightness<p.brightness[0],bright=brightness!==null&&brightness>p.brightness[1],lowPitch=pitch!==null&&pitch<p.pitch[0],highPitch=pitch!==null&&pitch>p.pitch[1];
    let label='Within selected practice bands',cue='This word has no clear out-of-band cue in the available voiced frames. Compare it with the neighboring words and your playback.';
    if(lowPitch&&dark){label='More masculine-leaning acoustic cues relative to this goal';cue='Try a gentle “mmm–ee” lead-in, then repeat the word with a slightly higher easy pitch and a forward, clear resonance. Notice a light buzz near the front of the hard palate; keep the throat relaxed.'}
    else if(lowPitch){label='Lower pitch cue relative to this goal';cue='Try the word after a small, comfortable “mm” glide. Let it settle just above your usual floor; do not push the larynx or raise every word.'}
    else if(dark){label='Darker resonance proxy relative to this goal';cue='Try a soft “mmm–ee” transition. Keep the tongue comfortably forward and high for the vowel, and notice light vibration toward the roof/front of the mouth without squeezing.'}
    else if(highPitch&&bright){label='More feminine-leaning acoustic cues relative to this goal';cue='This word is above the selected pitch and brightness bands. Keep the clarity but release some pitch and effort; a warmer, roomier vowel may help.'}
    else if(bright){label='Brighter spectral balance than this goal';cue='Keep the sound clear while allowing a little more oral space. Release a hard smile and let the jaw and tongue stay easy.'}
    else if(highPitch){label='Higher pitch cue relative to this goal';cue='Keep the resonance you like, then let the word settle slightly lower into a comfortable center.'}
    if(!enough){label='Not enough timing or voiced frames';cue='The word boundary or voiced sample count is too uncertain for a physical correction. Replay the phrase and try a slower, clearly spoken take.'}
    findings.push({word:token.word,start:token.start,end:token.end,pitch:pitch===null?null:Math.round(pitch),brightness:brightness===null?null:+brightness.toFixed(1),samples:voiceFrames.length,label,cue,agreement:enough?Math.round(promptMatch*100):0,review:!enough});
  }
  if(!findings.length)return {status:'No prompt words could be matched with reliable timing.',findings:[]};
  const exact=timed.length>0&&timed.every(item=>!item.approximate);
  return {status:`${findings.length} words aligned ${exact?'from Workers AI word timestamps':'approximately from cloud timestamps'} · prompt agreement ${Math.round(promptMatch*100)}%. Word-level gendered labels are experimental acoustic cues, not a listener or identity classification.`,findings};
}
function alignWords(expected,observed){
  const rows=expected.length+1,cols=observed.length+1,dp=Array.from({length:rows},()=>Array(cols).fill(0));
  for(let i=0;i<rows;i++)dp[i][0]=i;for(let j=0;j<cols;j++)dp[0][j]=j;
  for(let i=1;i<rows;i++)for(let j=1;j<cols;j++)dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+(expected[i-1]===observed[j-1]?0:1));
  const pairs=[];let i=expected.length,j=observed.length;
  while(i&&j){if(expected[i-1]===observed[j-1]&&dp[i][j]===dp[i-1][j-1]){pairs.push([i-1,j-1]);i--;j--}else if(dp[i][j]===dp[i-1][j-1]+1){i--;j--}else if(dp[i][j]===dp[i-1][j]+1)i--;else j--}
  return pairs.reverse();
}
function renderWordAnalysis(result){
  const list=el('wordFindings');if(!result?.findings?.length){list.innerHTML='<p class="privacy-line">No dependable word-level measurements to show for this take.</p>';return}
  list.innerHTML=`<div><span class="kicker">WORD MAP · EXPERIMENTAL</span><p class="cloud-analysis-note">These labels summarize pitch and spectral balance relative to your selected goal. They are not direct phoneme recognition or a universal gender judgment.</p></div>`+result.findings.map((item,index)=>`<article class="word-finding"><div class="word-finding-head"><strong>${escapeHtml(item.word)}</strong><span class="finding-tag">${escapeHtml(item.label)}</span><small>${item.pitch===null?'pitch n/a':`${item.pitch} Hz`} · ${item.brightness===null?'resonance n/a':`${item.brightness} dB`} · ${item.agreement}% transcript agreement</small></div><p>${escapeHtml(item.cue)}</p><button data-word-play="${index}">▶ Play this word</button></article>`).join('');
  document.querySelectorAll('[data-word-play]').forEach(button=>button.onclick=()=>playWord(result.findings[+button.dataset.wordPlay]));
}
function playWord(word){const player=el('recordingPlayback'),end=word.end+.08;player.ontimeupdate=()=>{if(player.currentTime>=end){player.pause();player.ontimeupdate=null}};player.currentTime=Math.max(0,word.start-.12);player.play().catch(()=>{player.ontimeupdate=null})}

function buildAdjustments(r){
  const p=presets[state.goal],items=[];
  if(r.raw.pitchFloor<p.pitch[0])items.push({priority:100-r.scores.pitch,title:'Protect the pitch floor',summary:`Your lower edge was ${r.raw.pitchFloor} Hz; the ${p.name} starting range begins near ${p.pitch[0]} Hz.`,detail:`Begin with one easy “mmm” glide and aim only ${Math.max(1,Math.round(12*Math.log2(p.pitch[0]/Math.max(r.raw.pitchFloor,1))))} semitone(s) higher. Keep energy through the final words rather than forcing every ending upward.`});
  else if(r.raw.pitch>p.pitch[1])items.push({priority:100-r.scores.pitch,title:'Let pitch settle',summary:`Your median was ${r.raw.pitch} Hz, above this preset’s ${p.pitch[0]}–${p.pitch[1]} Hz range.`,detail:'Keep the same resonance and lightness, but release pitch slightly toward a more sustainable center.'});
  else items.push({priority:25,title:'Stabilize target coverage',summary:`Your median pitch was ${r.raw.pitch} Hz with ${r.raw.pitchCoverage}% of voiced frames in range.`,detail:r.raw.pitchCoverage<65?'Repeat more slowly and keep the phrase ending above your comfortable floor.':'Pitch is well placed; give attention to resonance, expression, and comfort next.'});
  if(r.raw.brightness<p.brightness[0])items.push({priority:100-r.scores.brightness,title:'Explore a clearer resonance',summary:`Pitch-aware spectral balance was ${r.raw.brightness} dB, below this preset’s practice band (${p.brightness[0]} to ${p.brightness[1]} dB).`,detail:'Try a light “mmm–eee” anchor, keep the tongue comfortably forward, then repeat without smiling hard or squeezing. Treat the meter as one trend to compare under the same mic setup, not a verdict on how you sound.'});
  else if(r.raw.brightness>p.brightness[1])items.push({priority:100-r.scores.brightness,title:'Explore a warmer resonance',summary:`Pitch-aware spectral balance was ${r.raw.brightness} dB, above the selected practice band.`,detail:'Keep clarity but allow a little more internal space. Avoid pulling the lips wide or making the sound thin; use the same mic position for comparisons.'});
  else items.push({priority:20,title:'Keep resonance repeatable',summary:`Pitch-aware spectral balance landed inside the selected band at ${r.raw.brightness} dB.`,detail:`${r.raw.brightnessCoverage}% of voiced frames stayed there. This spectral proxy is microphone- and vowel-sensitive; compare similar phrases under the same setup.`});
  if(r.raw.movement<p.movement[0])items.push({priority:100-r.scores.movement,title:'Add meaningful movement',summary:`Pitch span was ${r.raw.movement} semitones; this drill’s preset starts near ${p.movement[0]}.`,detail:'Choose two meaningful words. Lengthen and move those words slightly instead of raising every ending.'});
  else if(r.raw.movement>p.movement[1])items.push({priority:100-r.scores.movement,title:'Simplify the melody',summary:`Pitch span was ${r.raw.movement} semitones, above the selected practice range.`,detail:'Keep one primary emphasis per thought and let unimportant words remain closer to center.'});
  else items.push({priority:18,title:'Use movement for meaning',summary:`Pitch movement was ${r.raw.movement} semitones, within target.`,detail:'Listen back for whether the largest movement landed on the word you intended to emphasize.'});
  if(r.scores.ease<72)items.push({priority:100-r.scores.ease,title:'Reset signal control',summary:`Only ${r.raw.continuity}% of audible frames produced a confident pitch estimate.`,detail:'Use less volume, one gentle straw or “voo” glide, and a shorter phrase. If the voice feels rough or effortful, stop for today.'});
  if(r.clarity!==null&&r.clarity<75)items.push({priority:45,title:'Clarify the words',summary:`The browser matched ${r.clarity}% of the prompt.`,detail:'Slow slightly, keep consonants quick and precise, and avoid trading intelligibility for a lighter sound.'});
  if(r.raw.pace!==null&&(r.raw.pace<85||r.raw.pace>210))items.push({priority:30,title:'Check pacing',summary:`Estimated pace was ${r.raw.pace} words per minute.`,detail:r.raw.pace>210?'Group words by meaning and allow small pauses between ideas.':'Keep the easy sound, then reconnect words into natural thought groups.'});
  return items.sort((a,b)=>b.priority-a.priority)
}

function completeActiveLesson(){
  if(activeActivityId&&!activityComplete(activeActivityId))state.completed.push({activity:activeActivityId,lesson:activeLesson.id,date:todayKey()});
  else if(!activeActivityId)state.completed.push({lesson:activeLesson.id,date:todayKey()});
}
function advanceAfterSave(){
  const context=activeActivityId?activityContext(activeActivityId):null;
  renderCourse();
  if(context){const next=context.session.activities.slice(context.index+1).find(item=>!activityComplete(item.id));if(next){startLesson(next.drill,next.id);return}showView('today');return}
  const idx=lessons.findIndex(item=>item.id===activeLesson.id);startLesson(lessons[(idx+1)%lessons.length].id);
}
function showRest(attempt){
  el('restPanel').hidden=false;
  const baselineLine=state.baselineAttemptId===attempt.id?' This take is also saved as your baseline.':'';
  el('restMessage').textContent=`This take is saved. Comfort was ${attempt.comfort} out of 5, so the rest of the session is paused. That is information, not a failed score. Stop for today, or try one easy straw or lip-trill reset. You can resume ${activeLesson.title} whenever your voice feels ready.${baselineLine}`;
  el('saveContinueButton').disabled=true;
  el('restHeading').focus();
}
async function saveCurrent(){
  if(!currentResult||takeSaved)return;
  const id=crypto.randomUUID(), comfort=+el('comfortRating').value;
  const attempt={id,date:new Date().toISOString(),lesson:activeLesson.id,lessonTitle:activeLesson.title,activity:activeActivityId,goal:state.goal,comfort,alignment:+el('alignmentRating').value,...currentResult};
  const reference=state.attempts.find(item=>item.id===attempt.baselineComparison?.id);
  if(attempt.baselineComparison&&Number.isFinite(reference?.comfort))attempt.baselineComparison.comfortDelta=comfort-reference.comfort;
  const pausing=shouldPauseForComfort(comfort);
  if(adoptBaseline||(activeLesson.id==='baseline'&&!state.baselineAttemptId&&!pausing))state.baselineAttemptId=id;
  state.attempts.push(attempt);
  takeSaved=true;
  if(pausing){
    state.pausedSession={lesson:activeLesson.id,activity:activeActivityId,date:attempt.date,comfort,lessonTitle:activeLesson.title};
    if(state.saveAudio&&currentBlob)await saveAudio(id,currentBlob);
    persist({immediate:true}); renderCourse(); renderToday(); showRest(attempt); return;
  }
  const samePaused=state.pausedSession&&state.pausedSession.lesson===activeLesson.id&&(state.pausedSession.activity||null)===(activeActivityId||null);
  if(samePaused)state.pausedSession=null;
  completeActiveLesson();
  if(state.saveAudio&&currentBlob)await saveAudio(id,currentBlob);
  persist({immediate:true});
  advanceAfterSave();
}
function continueAfterRest(){
  if(!takeSaved||el('continueAnyway').disabled)return;
  el('continueAnyway').disabled=true;
  state.pausedSession=null;
  completeActiveLesson();
  persist({immediate:true});
  advanceAfterSave();
}

function openDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open(`${DB_NAME}-${account.id}`,1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('audio'))req.result.createObjectStore('audio')};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
function audioRequest(mode,run){return openDB().then(db=>new Promise((resolve,reject)=>{const tx=db.transaction('audio',mode);const result=run(tx.objectStore('audio'));tx.oncomplete=()=>resolve(result?.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Audio request aborted'))}))}
async function saveAudio(id,blob){try{await audioRequest('readwrite',store=>store.put(blob,id))}catch(e){console.warn('Audio save failed',e)}}
async function loadAudio(id){try{return await audioRequest('readonly',store=>store.get(id))}catch{return null}}
async function clearSavedAudio(){try{await audioRequest('readwrite',store=>store.clear())}catch(e){console.warn('Audio clear failed',e)}}

function resetMeters(){samples=[];el('pitchValue').textContent='—';el('brightnessValue').textContent='—';el('movementValue').textContent='—';el('easeValue').textContent='—';el('visualizerIdle').style.display='grid';const c=el('waveCanvas');c.getContext('2d').clearRect(0,0,c.width,c.height)}

function driveHistoryRow(drive){
  const routine=window.COURSE_CONTENT.drives.find(item=>item.id===drive.routineId);
  const coach=drive.kind==='coach';
  const extra=driveHistoryExtras(drive);
  const comfortText=Number.isInteger(drive.comfort)?`${drive.comfort}/5 comfort`:'';
  const detail=extra.score||(coach?(drive.coach?.summary||'Drive coach'):'no voice score');
  const minutes=drive.actualMinutes?`${drive.actualMinutes} min`:(Number.isInteger(drive.comfort)?'Check-in':(coach?'under 1 min':'Skipped'));
  return `<div class="history-row"><div><b>${coach?'Drive coach':'Drive'} · ${escapeHtml(routine?.title||drive.routineId)}</b><br><small>${new Date(drive.date).toLocaleString()} · ${escapeHtml(detail)}</small>${extra.hardHtml}</div><b>${minutes}</b><small>${escapeHtml(comfortText)}</small><small>cue ${escapeHtml(drive.cueHeld)}</small><small></small><small></small></div>`;
}
function renderProgress(){
  const at=state.attempts, totalSec=at.reduce((s,a)=>s+(a.duration||0),0), avg=at.length?Math.round(at.reduce((s,a)=>s+a.overall,0)/at.length):0, best=at.length?Math.max(...at.map(a=>a.overall)):0;
  const selfRated=at.filter(a=>Number.isFinite(a.comfort)&&Number.isFinite(a.alignment)),progress=courseProgress();
  const comfort=selfRated.length?(selfRated.reduce((sum,a)=>sum+a.comfort,0)/selfRated.length).toFixed(1):'—',alignment=selfRated.length?(selfRated.reduce((sum,a)=>sum+a.alignment,0)/selfRated.length).toFixed(1):'—';
  const driveMin=driveLogs().reduce((sum,entry)=>sum+(entry.actualMinutes||0),0);
  const fromBaseline=baselineProgressLabel();
  const accountBlend=at.some(item=>item.baselineComparison?.source==='account');
  const phraseBlend=at.some(item=>item.baselineComparison);
  const averageDetail=accountBlend?'Goal band blended with your baseline':phraseBlend?'Includes change from an earlier take of the same phrase':'Distance to the goal band';
  el('statGrid').innerHTML=[['Practice time',`${Math.floor(totalSec/60)+driveMin}m`,`${at.length} saved takes · ${driveMin} drive min`],['Course',`${progress.percent}%`,`${progress.done} of ${progress.total} activities`],['Current streak',`${calculateStreak()} days`,'Consistency over intensity'],['Average score',avg||'—',averageDetail],['From baseline',fromBaseline.value,fromBaseline.detail],['Average comfort',comfort==='\u2014'?comfort:`${comfort}/5`,'Your rating after each take'],['Sounds like me',alignment==='\u2014'?alignment:`${alignment}/5`,'Your alignment rating']].map(x=>`<div class="stat-card"><span>${escapeHtml(x[0])}</span><strong>${escapeHtml(String(x[1]))}</strong><small>${escapeHtml(x[2])}</small></div>`).join('');
  const history=[...at.map(attempt=>({kind:'attempt',date:attempt.date,attempt})),...driveLogs().map(drive=>({kind:'drive',date:drive.date,drive}))].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,12);
  el('historyList').innerHTML=history.length?history.map(item=>{
    if(item.kind==='drive')return driveHistoryRow(item.drive);
    const a=item.attempt;return `<div class="history-row"><div><b>${escapeHtml(a.lessonTitle)}</b><br><small>${new Date(a.date).toLocaleString()} · ${escapeHtml(presets[a.goal]?.name||a.goal)}</small><br><button type="button" class="text-button history-play" data-play-attempt="${escapeHtml(a.id)}">Play saved audio</button></div><b>${a.overall}</b><small>${a.scores.pitch} pitch</small><small>${a.scores.brightness} spectral</small><small>${a.comfort?`${a.comfort}/5 comfort`:`${a.scores.movement} move`}</small><small>${a.alignment?`${a.alignment}/5 self`:`${a.scores.ease} control`}</small></div>`;
  }).join(''):'<p class="privacy-line">No saved attempts yet.</p>';
  document.querySelectorAll('[data-play-attempt]').forEach(button=>button.onclick=()=>playSavedAttempt(button.dataset.playAttempt));
  drawProgressChart();
}
function baselineProgressLabel(){
  const reference=baselineAttempt();
  const preset=presets[state.goal]||presets.balanced;
  if(metricSnapshot(reference)){
    const later=[...state.attempts].reverse().find(item=>item.id!==reference.id&&metricSnapshot(item));
    if(!later)return {value:'Snapshot',detail:'Record another take to see change'};
    const delta=Math.round(later.raw.pitch-reference.raw.pitch);
    return {value:delta>0?`+${delta} Hz`:delta<0?`${delta} Hz`:'0 Hz',detail:describePitchDelta(delta,later.raw.pitch,preset.pitch)};
  }
  const compared=[...state.attempts].reverse().find(item=>item.baselineComparison&&Number.isFinite(item.baselineComparison.pitchDelta));
  if(!compared)return {value:'—',detail:'Record a baseline to see change'};
  const delta=compared.baselineComparison.pitchDelta;
  return {value:delta>0?`+${delta} Hz`:delta<0?`${delta} Hz`:'0 Hz',detail:`${compared.baselineComparison.message} A Natural voice snapshot will make this the same reference for every drill.`};
}
function drawProgressChart(){
  const c=el('progressCanvas'),ctx=c.getContext('2d'),metric=el('chartMetric').value,data=state.attempts.slice(-12).map(a=>metric==='overall'?a.overall:a.scores[metric]); const w=c.width,h=c.height,pad=45;ctx.clearRect(0,0,w,h);el('emptyChart').style.display=data.length?'none':'grid';
  ctx.strokeStyle='#dedbd3';ctx.lineWidth=1;ctx.font='22px DM Sans';ctx.fillStyle='#8b928e';for(let v=0;v<=100;v+=25){const y=h-pad-v/100*(h-pad*2);ctx.beginPath();ctx.moveTo(pad,y);ctx.lineTo(w-pad,y);ctx.stroke();ctx.fillText(v,pad-35,y+7)}if(!data.length)return;
  ctx.strokeStyle='#e77a60';ctx.lineWidth=5;ctx.lineJoin='round';ctx.beginPath();data.forEach((v,i)=>{const x=pad+(data.length===1?.5:i/(data.length-1))*(w-pad*2),y=h-pad-v/100*(h-pad*2);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke();data.forEach((v,i)=>{const x=pad+(data.length===1?.5:i/(data.length-1))*(w-pad*2),y=h-pad-v/100*(h-pad*2);ctx.fillStyle='#fffdf8';ctx.strokeStyle='#e77a60';ctx.lineWidth=4;ctx.beginPath();ctx.arc(x,y,8,0,Math.PI*2);ctx.fill();ctx.stroke()});
}

function renderSettings(){
  el('saveAudioToggle').checked=state.saveAudio;
  const breath=el('breathCueToggle');
  if(breath) breath.checked=readBreathCue(localStorage);
  el('presetCards').innerHTML=Object.entries(presets).map(([k,p])=>`<label class="preset-card ${k===state.goal?'active':''}"><input type="radio" name="preset" value="${k}" ${k===state.goal?'checked':''}><span><strong>${p.name}</strong><small>${p.description}</small></span></label>`).join('');
  document.querySelectorAll('input[name=preset]').forEach(r=>r.onchange=()=>setGoal(r.value));
}
function setGoal(goal){state.goal=goal;persist();el('goalSelect').value=goal;const ramona=el('ramonaReference');if(ramona){ramona.hidden=goal!=='ramona';ramona.querySelector('iframe').src=''}updateGoalUI();renderSettings()}
async function playSavedAttempt(id){
  const status=el('historyAudioStatus');
  try{
    const blob=await loadAudio(id);
    if(!blob){status.textContent='No recording is stored for this take. Turn on “Save audio with attempts” before you record.';el('historyPlayback').hidden=true;return}
    if(historyAudioUrl)URL.revokeObjectURL(historyAudioUrl);
    historyAudioUrl=URL.createObjectURL(blob);
    const player=el('historyPlayback');
    player.hidden=false;player.src=historyAudioUrl;status.textContent='';
    await player.play();
  }catch{status.textContent='This recording could not be played in this browser.'}
}
function setMenuOpen(open){
  document.querySelector('.sidebar').classList.toggle('open',!!open);
  el('menuButton').setAttribute('aria-expanded',open?'true':'false');
  el('drawerScrim').hidden=!open;
}
function bindEvents(){
  document.querySelectorAll('.nav-item[data-view]').forEach(n=>n.onclick=()=>showView(n.dataset.view));
  mountDriveCoach({
    getLines(){const drive=currentDrive();const phrases=(drive?.lines||[]).map(id=>lessons.find(item=>item.id===id)?.phrase).filter(Boolean);return orderPracticePhrases(phrases)},
    getPlanned:()=>30,
    getRoutine:()=>currentDrive()?.id||'week-1',
    getGoal:()=>presets[state.goal]||presets.balanced,
    save(entry){if(!keepDriveLog(entry))return;if(!Array.isArray(state.driveLog))state.driveLog=[];const index=state.driveLog.findIndex(item=>item.id===entry.id);if(index>=0)state.driveLog[index]=entry;else state.driveLog.push(entry);persist({immediate:true});renderToday();renderProgress()}
  });
  el('goalSelect').onchange=e=>setGoal(e.target.value);el('openDrive').onclick=()=>showView('drive');el('saveDrive').onclick=saveDriveCheckin;el('driveComfort').oninput=e=>{el('driveComfortOutput').textContent=`${e.target.value} / 5`};el('playReference').onclick=speakReference;el('playRamonaReference').onclick=playRamonaReference;el('ramonaClipSelect').onchange=()=>{el('ramonaReference').querySelector('iframe').src='';el('ramonaClipStatus').textContent='Press Play character clip to load this official clip.'};el('recordButton').onclick=toggleRecording;el('exitPractice').onclick=()=>showView('today');el('retryButton').onclick=()=>{resetMeters();showView('practice')};el('saveContinueButton').onclick=saveCurrent;
  el('cloudAnalyzeButton').onclick=analyzeWordsWithCloud;
  el('comfortRating').oninput=e=>{el('comfortOutput').textContent=`${e.target.value} / 5`;refreshComfortCue()};el('alignmentRating').oninput=e=>el('alignmentOutput').textContent=`${e.target.value} / 5`;el('listenerReview').onchange=updateValidatedScore;
  el('baselineButton').onclick=()=>{adoptBaseline=!adoptBaseline;refreshComfortCue()};
  el('restNow').onclick=()=>showView('today');
  el('easyReset').onclick=()=>startLesson('sovt');
  el('continueAnyway').onclick=continueAfterRest;
  el('resumePaused').onclick=resumePaused;
  el('dismissPause').onclick=dismissPause;
  el('menuButton').onclick=event=>{event.stopPropagation();setMenuOpen(!document.querySelector('.sidebar').classList.contains('open'))};
  el('drawerScrim').onclick=()=>setMenuOpen(false);
  el('privacyButton').onclick=()=>el('modalBackdrop').hidden=false;el('modalClose').onclick=el('modalOkay').onclick=()=>el('modalBackdrop').hidden=true;
  el('chartMetric').onchange=drawProgressChart;el('saveAudioToggle').onchange=e=>{state.saveAudio=e.target.checked;persist()};
  const breathToggle=el('breathCueToggle');
  if(breathToggle) breathToggle.onchange=e=>writeBreathCue(localStorage,e.target.checked);
  el('exportData').onclick=()=>exportProgress();
  el('retrySync').onclick=async()=>{syncFailed=false;el('retrySync').disabled=true;try{await rebase()}catch{}await persist({immediate:true});el('retrySync').disabled=false};
  el('loadLatest').onclick=()=>{if(confirm('Discard pending changes on this device and load the latest saved progress? Export a backup in Settings first.')){localStorage.removeItem(pendingKey());location.reload()}};
    el('importLocal').onclick=()=>{if(confirm('Replace this account’s progress with the previous progress from this browser? Export your current account progress first.')){state=loadState();persist({immediate:true});renderAll()}};
  el('logoutButton').onclick=async()=>{
    el('logoutButton').disabled=true;
    try{await flushPersist();if(syncFailed)throw new Error('Save or export pending changes before signing out.');await api('/api/auth/logout',{method:'POST'});location.reload()}
    catch(error){syncMessage(error.message,true);el('logoutButton').disabled=false}
  };
  el('clearHistory').onclick=async()=>{
    if(!confirm('Clear saved scores, course completion, drive check-ins, and recordings stored in this browser?'))return;
    state.attempts=[];state.completed=[];state.driveLog=[];state.baselineAttemptId=null;state.pausedSession=null;
    if(historyAudioUrl){URL.revokeObjectURL(historyAudioUrl);historyAudioUrl=null}
    const player=el('historyPlayback');player.pause();player.removeAttribute('src');player.hidden=true;el('historyAudioStatus').textContent='';
    persist({immediate:true});renderProgress();renderToday();renderCourse();
    await clearSavedAudio();
  };
  el('resetData').onclick=async()=>{if(confirm('Reset progress and settings in your account on all devices, and delete this account’s recordings from this browser?')){state=structuredClone(defaultState);await persist({immediate:true});if(syncFailed)return;indexedDB.deleteDatabase(`${DB_NAME}-${account.id}`);location.reload()}};
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape')setMenuOpen(false);
    if(e.code==='Space'&&el('practiceView').classList.contains('active')&&!['INPUT','BUTTON','SELECT','TEXTAREA'].includes(document.activeElement.tagName)){e.preventDefault();toggleRecording()}
  });
}

window.addEventListener('online',async()=>{if(!account||!syncFailed)return;syncFailed=false;try{await rebase()}catch{}persist({immediate:true})});
window.addEventListener('beforeunload',event=>{if(account&&localStorage.getItem(pendingKey())){event.preventDefault();event.returnValue=''}});
startAuth();
