export interface HistoryRecord {id:string;run_id:string;root_id:string;workspace:string;storage_root:string;storage_scope:string;title:string;model:string;provider:string;agent:string;status:string;started_at:string;ended_at:string|null;session_id:string;native_policy:string;group:string;kind:string;mode:string;effort:string;available:boolean;reason?:string}
export interface Preview {record:HistoryRecord;brief:string;answer:string;limit_chars:number}
export interface Root {root_id:string;workspace:string;root:string}
export interface RecordsResponse {records:HistoryRecord[];roots:Root[];csrf:string;import_cli:{executable:string;script:string;arguments:string[]}}
export interface DeletePreview {ticket:string|null;candidates:HistoryRecord[];blocked:{id:string|null;reason:string}[];previews:Preview[];native_cleanup:{requested:boolean;candidates:{file:string;session_id:string;ids:string[]}[];retained:{id:string;reason:string}[]}}
export interface DeleteResult {deleted:string[];native_deleted:string[];blocked:{id:string|null;reason:string}[];native_cleanup?:DeletePreview['native_cleanup']}
