// support.js
// Extracted from the inline <script> that used to live in support.html.
// Behavior is unchanged — this file talks directly to Supabase (not to
// the Node/Express API in this project). That's intentional: the AI
// backend replies by inserting rows into the same `support_messages`
// table, and this script's existing Realtime subscription picks those
// rows up automatically, indistinguishable from a human admin reply.
// See Chapter 4 of the developer guide for the full data-flow explanation.

(function(){
  'use strict';

  var sb = supabase.createClient(
    'https://bwcsuxvcqmykhckxqgjh.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ3Y3N1eHZjcW15a2hja3hxZ2poIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyOTE1NjIsImV4cCI6MjA5ODg2NzU2Mn0.rAXetUdSG-uzEhQfvhgK8Kn-K5Hxyxx9M7QO4nKTZiA'
  );

  var THREAD_KEY = 'lm_support_thread_id';
  var isEmbedded = (window.self !== window.top);
  document.body.classList.add(isEmbedded ? 'embedded' : 'standalone');

  var el = {
    body: document.getElementById('supBody'),
    thread: document.getElementById('supThread'),
    threadDivider: document.getElementById('supThreadDivider'),
    typing: document.getElementById('supTyping'),
    input: document.getElementById('supInput'),
    sendBtn: document.getElementById('supSendBtn'),
    closeInline: document.getElementById('supCloseInline'),
    backBtn: document.getElementById('supBackBtn')
  };

  var threadId = localStorage.getItem(THREAD_KEY) || null;
  var channel = null;
  var renderedIds = {};

  function closePanel(){
    if (isEmbedded) {
      window.parent.postMessage('landmark-support:close', '*');
    } else if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = 'index.html';
    }
  }
  el.closeInline.addEventListener('click', closePanel);
  el.backBtn.addEventListener('click', closePanel);

  function timeLabel(iso){
    try{
      var d = new Date(iso);
      return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    }catch(e){ return ''; }
  }

  function scrollToBottom(){
    el.body.scrollTop = el.body.scrollHeight;
  }

  function renderMessage(msg){
    if (renderedIds[msg.id]) return;
    renderedIds[msg.id] = true;
    el.threadDivider.style.display = 'flex';

    var wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.alignItems = msg.sender === 'visitor' ? 'flex-end' : 'flex-start';

    var bubble = document.createElement('div');
    bubble.className = 'sup-msg ' + (msg.sender === 'visitor' ? 'visitor' : 'admin');
    bubble.textContent = msg.message;

    var time = document.createElement('div');
    time.className = 'sup-msg-time';
    time.textContent = (msg.sender === 'visitor' ? 'You' : 'Landmark Support') + ' · ' + timeLabel(msg.created_at);

    wrap.appendChild(bubble);
    wrap.appendChild(time);
    el.thread.appendChild(wrap);
    scrollToBottom();
  }

  function showTyping(on){
    el.typing.classList.toggle('show', !!on);
    if (on) scrollToBottom();
  }

  async function loadExistingThread(){
    if (!threadId) return;
    try{
      var { data, error } = await sb
        .from('support_messages')
        .select('id, sender, message, created_at')
        .eq('thread_id', threadId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      (data || []).forEach(renderMessage);
      subscribeToThread();
    }catch(err){
      console.warn('Could not load support thread:', err);
    }
  }

  function subscribeToThread(){
    if (!threadId || channel) return;
    channel = sb.channel('support-thread-' + threadId)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'support_messages',
        filter: 'thread_id=eq.' + threadId
      }, function(payload){
        showTyping(false);
        renderMessage(payload.new);
      })
      .subscribe();
  }

  async function ensureThread(){
    if (threadId) return threadId;
    var { data, error } = await sb
      .from('support_threads')
      .insert({})
      .select('id')
      .single();
    if (error) throw error;
    threadId = data.id;
    localStorage.setItem(THREAD_KEY, threadId);
    subscribeToThread();
    return threadId;
  }

  async function sendMessage(text){
    text = (text || '').trim();
    if (!text) return;

    el.sendBtn.disabled = true;
    try{
      var tId = await ensureThread();
      var optimisticId = 'local-' + Date.now();
      renderMessage({
        id: optimisticId,
        sender: 'visitor',
        message: text,
        created_at: new Date().toISOString()
      });

      var { error } = await sb.from('support_messages').insert({
        thread_id: tId,
        sender: 'visitor',
        message: text
      });
      if (error) throw error;

      // Light acknowledgment so the panel doesn't feel like it went nowhere,
      // while we wait for a real reply to arrive over realtime.
      showTyping(true);
      window.setTimeout(function(){ showTyping(false); }, 4500);
    }catch(err){
      console.error('Failed to send support message:', err);
    }finally{
      el.sendBtn.disabled = false;
    }
  }

  el.sendBtn.addEventListener('click', function(){
    var text = el.input.value;
    el.input.value = '';
    el.input.style.height = 'auto';
    sendMessage(text);
  });

  el.input.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      el.sendBtn.click();
    }
  });

  el.input.addEventListener('input', function(){
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 110) + 'px';
  });

  document.querySelectorAll('.sup-chip, .sup-faq-card').forEach(function(node){
    node.addEventListener('click', function(){
      sendMessage(node.getAttribute('data-msg'));
    });
  });

  loadExistingThread();
