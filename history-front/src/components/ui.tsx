import {forwardRef, type ButtonHTMLAttributes} from 'react';
import {X} from 'lucide-react';
import {cn} from '@/lib/utils';
export const Button = forwardRef<HTMLButtonElement,ButtonHTMLAttributes<HTMLButtonElement>&{variant?:string;size?:string}>(({className,variant,size,...props},ref)=><button ref={ref} type="button" className={cn('button',variant==='ghost'&&'subtle',className)} {...props}/>);
export function IconPlaceholder(_props:Record<string,string>) { return <X size={16}/>; }
