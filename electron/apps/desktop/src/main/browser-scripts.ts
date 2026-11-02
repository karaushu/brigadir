/** Serialized functions contain no app bindings and return bounded page data. */
export const readPage = `(selector) => {
  const root=selector?document.querySelector(selector):document.body;
  if(!root)return {error:'Element not found'};
  return {url:location.href,title:document.title,text:(root.innerText||root.textContent||'').slice(0,32000),html:root.outerHTML.slice(0,16000)};
}`;
export const describeNode = `function(){
  const node=this,box=node.getBoundingClientRect();
  let selector=node.dataset.testid?'[data-testid='+JSON.stringify(node.dataset.testid)+']':node.id?'#'+CSS.escape(node.id):'';
  if(!selector){const parts=[];let item=node;for(let n=0;item&&item.nodeType===1&&n<5;n++,item=item.parentElement){let part=item.tagName.toLowerCase();if(item.parentElement){const peers=[...item.parentElement.children].filter(peer=>peer.tagName===item.tagName);if(peers.length>1)part+=':nth-of-type('+(peers.indexOf(item)+1)+')';}parts.unshift(part);}selector=parts.join(' > ');}
  return {url:location.href,selector,html:node.outerHTML.slice(0,400),width:Math.round(box.width),height:Math.round(box.height)};
}`;
