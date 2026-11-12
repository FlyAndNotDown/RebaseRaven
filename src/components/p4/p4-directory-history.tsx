import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { P4Submitted, type SubmittedHistoryModel } from "@/components/p4/p4-submitted";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { errorMessage } from "@/lib/git";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { useP4 } from "@/state/p4-context";
import type { P4Changelist } from "@/types/p4";

const empty = () => ({changes:[] as P4Changelist[], hasMore:true, selected:null as string | null, detail:null as P4Changelist | null, loading:false, describing:false});

export function P4DirectoryHistory({path}: {path:string}) {
  const {t} = useTranslation();
  const {pathHistory, describeSubmitted} = useP4();
  const [state,setState] = useState(empty);
  const [filters,setFilters] = useState({user:"",client:""});
  const [error,setError] = useState<string | null>(null);
  const stateRef = useRef(state);
  useLayoutEffect(()=>{stateRef.current = state;},[state]);
  const filterRef = useRef(filters);
  const generation = useRef(0);
  const detailToken = useRef(0);
  const live = useRef(false);
  const paging = useRef(false);

  const loadSubmitted = useCallback(async (more=false) => {
    if (!live.current || paging.current || more && !stateRef.current.hasMore) return;
    const token = generation.current;
    const before = more ? Number(stateRef.current.changes.at(-1)?.id) || null : null;
    paging.current = true;setError(null);
    setState(current => ({...(more ? current : empty()), loading:true}));
    try {
      const page = await pathHistory(path,{...filterRef.current,query:"",before,limit:50,scanLimit:500});
      if (!live.current || token !== generation.current) return;
      setState(current => {
        const known = new Set(more ? current.changes.map(change=>change.id) : []);
        return {...current,changes:[...(more ? current.changes : []),...page.changes.filter(change=>!known.has(change.id))],hasMore:page.hasMore};
      });
    } catch (caught) {if (live.current && token === generation.current) setError(p4DisplayError(errorMessage(caught)));}
    finally {if (live.current && token === generation.current) {paging.current=false;setState(current=>({...current,loading:false}));}}
  },[path,pathHistory]);

  const selectSubmitted = useCallback(async (id:string) => {
    if (!live.current || stateRef.current.selected === id && stateRef.current.detail?.id === id) return;
    const token=++detailToken.current, scope=generation.current;
    setError(null);setState(current=>({...current,selected:id,detail:null,describing:true}));
    try {
      const detail=await describeSubmitted(id);
      if (live.current && token === detailToken.current && scope === generation.current) setState(current=>({...current,detail}));
    } catch (caught) {if (live.current && token === detailToken.current && scope === generation.current) setError(p4DisplayError(errorMessage(caught)));}
    finally {if (live.current && token === detailToken.current && scope === generation.current) setState(current=>({...current,describing:false}));}
  },[describeSubmitted]);

  const setSubmittedFilter = useCallback((user:string,client:string) => {
    if (filterRef.current.user === user && filterRef.current.client === client) return;
    filterRef.current={user,client};setFilters({user,client});++generation.current;++detailToken.current;paging.current=false;
    void loadSubmitted(false);
  },[loadSubmitted]);

  const searchSubmitted = useCallback(async (query:string,before:number | null,limit:number,scanLimit:number) => {
    const token=generation.current;
    try {
      const page=await pathHistory(path,{...filterRef.current,query,before,limit,scanLimit});
      return live.current && token === generation.current ? page : null;
    } catch (caught) {if (live.current && token === generation.current) setError(p4DisplayError(errorMessage(caught)));return null;}
  },[path,pathHistory]);

  const invalidate = useCallback(()=>{live.current=false;++generation.current;++detailToken.current;paging.current=false;},[]);
  useEffect(()=>{
    live.current=true;void loadSubmitted(false);
    return invalidate;
  },[invalidate,loadSubmitted]);

  const history:SubmittedHistoryModel={submitted:state.changes,submittedHasMore:state.hasMore,submittedUser:filters.user,submittedClient:filters.client,selectedSubmitted:state.selected,submittedDetail:state.detail,submittedLoading:state.loading || state.describing,loadSubmitted,selectSubmitted,setSubmittedFilter,searchSubmitted};
  return <div className="flex min-h-0 flex-1 flex-col">
    {error ? <div role="alert" className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs text-destructive"><span className="min-w-0 flex-1 break-words">{error}</span><Button size="xs" variant="outline" onClick={()=>{if (state.selected && !state.detail) void selectSubmitted(state.selected);else void loadSubmitted(false);}}>{t("common.retry")}</Button></div> : null}
    <P4Submitted layout="stacked" history={history} historyScope={path}/>
  </div>;
}
