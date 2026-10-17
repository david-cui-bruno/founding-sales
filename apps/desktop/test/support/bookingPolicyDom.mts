import {createRequire} from 'node:module';
// Node retains file: module URLs for PostgreSQL migrations. Only the renderer DOM is controlled.
const {JSDOM}=createRequire(import.meta.url)('jsdom') as {JSDOM:new(html:string,options:{url:string})=>{window:Window&typeof globalThis}};
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://desktop.example.test'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window)});
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
