import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Folder, MoreHorizontal } from 'lucide-react';
import { CreationDialog } from './CreationDialog.js';
import { FolderManager } from './ConversationFolders.js';
import { DisconnectedBotsSwitch, HostGroupingSwitch } from './SidebarLayoutSwitch.js';
import { RuntimeHostContext } from './RuntimeHost.js';
import { t } from './i18n.js';
import type { InboxHost } from './conversation-inbox.js';

/** Phone list preferences share the existing device settings. Folder writes
 * still use the selected host's existing manager and permission checks. */
export function MobileListOptions({ hosts, scopedHostId, visible, disabled, groupByHost, changeGroupByHost, showDisconnectedBots, changeShowDisconnectedBots }: {
  hosts: InboxHost[]; scopedHostId?: string; visible: boolean; disabled: boolean;
  groupByHost: boolean; changeGroupByHost?: (value: boolean) => void;
  showDisconnectedBots: boolean; changeShowDisconnectedBots?: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(false), [managedHostId, setManagedHostId] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const managedHost = hosts.find(host => host.id === managedHostId);
  const close = () => { setOpen(false); setManagedHostId(undefined); };
  useEffect(() => { if (!visible || disabled) close(); }, [visible, disabled]);
  useEffect(() => { close(); }, [scopedHostId]);
  useEffect(() => { if (managedHostId && !managedHost) close(); }, [managedHostId, managedHost]);
  useEffect(() => {
    const layout = matchMedia('(max-width:760px)');
    layout.addEventListener('change', close);
    return () => layout.removeEventListener('change', close);
  }, []);
  const folderHosts = scopedHostId ? hosts.filter(host => host.id === scopedHostId) : hosts;
  return <>
    <button ref={trigger} type="button" className="mh-icon-button mh-list-more" aria-label={t('列表选项')} title={t('列表选项')}
      aria-haspopup="dialog" aria-expanded={open} disabled={disabled || !hosts.length} onClick={() => setOpen(true)}><MoreHorizontal size={22} aria-hidden="true"/></button>
    {visible && open && !managedHostId && <CreationDialog title={t('列表选项')} closeLabel={t('关闭列表选项')} showHost={false} returnFocus={trigger} close={close} className="mh-list-options-dialog">
      <div className="mh-list-preferences">
        {hosts.length > 1 && !scopedHostId && changeGroupByHost && <HostGroupingSwitch checked={groupByHost} change={changeGroupByHost}/>}
        {changeShowDisconnectedBots && <DisconnectedBotsSwitch checked={showDisconnectedBots} change={changeShowDisconnectedBots}/>}
      </div>
      <div className="mh-list-folder-actions">
        {folderHosts.map(host => <button key={host.id} type="button" aria-label={folderHosts.length > 1 ? t('管理 {0} 的分组', host.name) : t('管理分组')} onClick={() => setManagedHostId(host.id)}>
          <Folder size={18} aria-hidden="true"/><span>{t('管理分组')}{folderHosts.length > 1 && <small>{host.name}</small>}</span><ChevronRight size={16} aria-hidden="true"/>
        </button>)}
      </div>
    </CreationDialog>}
    {visible && open && managedHost && <RuntimeHostContext.Provider value={managedHost.name}>
      <FolderManager key={managedHost.id} connection={managedHost.connection} initialView="manage" returnFocus={trigger} close={close}/>
    </RuntimeHostContext.Provider>}
  </>;
}
