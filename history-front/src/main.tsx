import React from 'react';
import {createRoot} from 'react-dom/client';
import {setNonce} from 'get-nonce';
import {App} from './App';
import './style.css';
// Radix scroll locking inserts a style element; the server grants only its per-response nonce.
const nonce=document.querySelector<HTMLMetaElement>('meta[name="foreman-style-nonce"]')?.content;
if(nonce)setNonce(nonce);
createRoot(document.getElementById('root')!).render(<App/>);
