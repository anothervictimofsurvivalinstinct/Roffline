var n=document.querySelector.bind(document),c=window.location.port!=="";var d={"Content-Type":"application/json","csrf-token":window.csrfToken};function r(e){return new Promise(t=>{setTimeout(t,e)})}if(window.location.hash.length>0){let e=n("header"),t=e?e.getBoundingClientRect().height:0;r(100).then(s=>{var o;(o=n("#bulk-import-reddit-subs"))==null||o.scrollIntoView(),window.scrollTo(0,window.scrollY-t)})}
