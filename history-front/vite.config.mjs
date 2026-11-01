import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
const out=new URL('../skills/codex-foreman/scripts/history-ui/',import.meta.url);
const notices={name:'foreman-license-notices',closeBundle(){for(const file of ['NOTICE','component-sources.json'])fs.copyFileSync(new URL(file,import.meta.url),new URL(file,out));fs.cpSync(new URL('vendor/licenses/',import.meta.url),new URL('licenses/',out),{recursive:true});}};
export default defineConfig({ plugins:[tailwindcss(),notices], resolve:{alias:{'@':fileURLToPath(new URL('./src',import.meta.url))}}, build:{outDir:fileURLToPath(out),emptyOutDir:true,cssCodeSplit:false,reportCompressedSize:false,rollupOptions:{onwarn(warning,warn){if(warning.code==='MODULE_LEVEL_DIRECTIVE'&&warning.message.includes('use client'))return;warn(warning);},output:{entryFileNames:'app.js',assetFileNames:asset=>asset.name?.endsWith('.css')?'style.css':'[name][extname]',codeSplitting:false}}} });
