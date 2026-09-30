// проверка вёрстки: горизонтальная прокрутка и вылезание за рамку webview при 380/900 в обеих темах
(function(){
  var html=document.documentElement, out=[];
  ['380','900','vscode'].forEach(function(w){ ['dark','light'].forEach(function(t){
    html.setAttribute('data-width',w); html.setAttribute('data-theme',t);
    var wv=document.querySelector('.preview-stage'); void wv.offsetWidth;
    var r=wv.getBoundingClientRect();
    if (wv.scrollWidth>wv.clientWidth+1) out.push(w+'/'+t+': webview scrollWidth '+wv.scrollWidth+' > '+wv.clientWidth);
    wv.querySelectorAll('*').forEach(function(el){
      var cs=getComputedStyle(el); if(cs.display==='none'||el.closest('[hidden]')) return;
      var b=el.getBoundingClientRect(); if(!b.width) return;
      if (b.right>r.right+1||b.left<r.left-1) out.push(w+'/'+t+': вылез '+el.tagName.toLowerCase()+'.'+(el.className||'').toString().split(' ')[0]+' right='+Math.round(b.right-r.left)+' left='+Math.round(b.left-r.left));
      if (el.scrollWidth>el.clientWidth+1 && cs.overflowX==='visible' && el.children.length===0 && cs.whiteSpace==='nowrap') out.push(w+'/'+t+': текст шире контейнера '+el.tagName.toLowerCase()+'.'+(el.className||'').toString().split(' ')[0]+' "'+el.textContent.trim().slice(0,30)+'"');
    });
    // прокручиваемые области: контент шире?
    wv.querySelectorAll('.feed,.pane,.aside,.log,.sheet,.list,.sidebar,.webview').forEach(function(el){ if(el.scrollWidth>el.clientWidth+1) out.push(w+'/'+t+': гориз. прокрутка в .'+el.className.split(' ')[0]+' '+el.scrollWidth+'>'+el.clientWidth); });
  });});
  var pre=document.createElement('pre'); pre.id='layout-report'; pre.textContent='REPORT\n'+(out.length?out.join('\n'):'OK')+'\nEND'; document.body.appendChild(pre);
})();
