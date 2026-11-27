import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Folder, MoreHorizontal } from 'lucide-react';
import { CreationDialog } from './CreationDialog.js';
import { CrossHostFolderManager, FolderManager } from './ConversationFolders.js';
import { DisconnectedBotsSwitch, HostGroupingSwitch } from './SidebarLayoutSwitch.js';
import { RuntimeHostContext } from './RuntimeHost.js';
import { t } from './i18n.js';
import type { InboxHost } from './conversation-inbox.js';

/** Phone list preferences share the existing device settings. In combined
 * multi-host view, "Manage folders" opens the unified cross-host manager;
 * single-host and grouped-by-host views retain per-host Hub managers. */
export function MobileListOptions({ hosts, registeredHostCount, activeHostId, scopedHostId, visible, disabled, groupByHost, changeGroupByHost, showDisconnectedBots, changeShowDisconnectedBots }: {
  hosts: InboxHost[]; registeredHostCount?: number; activeHostId?: string; scopedHostId?: string; visible: boolean; disabled: boolean;
  groupByHost: boolean; changeGroupByHost?: (value: boolean) => void;
  showDisconnectedBots: boolean; changeShowDisconnectedBots?: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [managedTarget, setManagedTarget] = useState<'cross' | string | undefined>();
  const trigger = useRef<HTMLButtonElement>(null);
  const multiHost = Math.max(hosts.length, registeredHostCount ?? 0) > 1;
  const combinedFolders = !groupByHost && !scopedHostId && multiHost;
  const managedHost = managedTarget && managedTarget !== 'cross' ? hosts.find(host => host.id === managedTarget) : undefined;
  const close = () => { setOpen(false); setManagedTarget(undefined); };
  useEffect(() => { if (!visible || disabled) close(); }, [visible, disabled]);
  useEffect(() => { close(); }, [scopedHostId]);
  useEffect(() => {
    if (managedTarget === 'cross' && !combinedFolders) close();
    else if (managedTarget && managedTarget !== 'cross' && !managedHost) close();
  }, [managedTarget, managedHost, combinedFolders]);
  useEffect(() => {
    const layout = matchMedia('(max-width:760px)');
    layout.addEventListener('change', close);
    return () => layout.removeEventListener('change', close);
  }, []);
  const folderHosts = scopedHostId ? hosts.filter(host => host.id === scopedHostId) : hosts;
  return <>
    <button ref={trigger} type="button" className="mh-icon-button mh-list-more" aria-label={t('列表选项')} title={t('列表选项')}
      aria-haspopup="dialog" aria-expanded={open} disabled={disabled || !hosts.length} onClick={() => setOpen(true)}><MoreHorizontal size={22} aria-hidden="true"/></button>
    {visible && open && !managedTarget && <CreationDialog title={t('列表选项')} closeLabel={t('关闭列表选项')} showHost={false} returnFocus={trigger} close={close} className="mh-list-options-dialog">
      <div className="mh-list-preferences">
        {multiHost && !scopedHostId && changeGroupByHost && <HostGroupingSwitch checked={groupByHost} change={changeGroupByHost}/>}
        {changeShowDisconnectedBots && <DisconnectedBotsSwitch checked={showDisconnectedBots} change={changeShowDisconnectedBots}/>}
      </div>
      <div className="mh-list-folder-actions">
        {combinedFolders ? <button type="button" aria-label={t('管理分组')} onClick={() => setManagedTarget('cross')}>
          <Folder size={18} aria-hidden="true"/><span>{t('管理分组')}<small>{t('跨主机排序与管理')}</small></span><ChevronRight size={16} aria-hidden="true"/>
        </button> : folderHosts.map(host => <button key={host.id} type="button" aria-label={folderHosts.length > 1 ? t('管理 {0} 的分组', host.name) : t('管理分组')} onClick={() => setManagedTarget(host.id)}>
          <Folder size={18} aria-hidden="true"/><span>{t('管理分组')}{folderHosts.length > 1 && <small>{host.name}</small>}</span><ChevronRight size={16} aria-hidden="true"/>
        </button>)}
      </div>
    </CreationDialog>}
    {visible && open && managedTarget === 'cross' && combinedFolders && <CrossHostFolderManager hosts={hosts} defaultHostId={activeHostId} returnFocus={trigger} close={close}/>}
    {visible && open && managedHost && <RuntimeHostContext.Provider value={managedHost.name}>
      <FolderManager key={managedHost.id} connection={managedHost.connection} initialView="manage" returnFocus={trigger} close={close}/>
    </RuntimeHostContext.Provider>}
  </>;
}
