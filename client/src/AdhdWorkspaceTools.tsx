import { listedConversations } from "./dispatcher.js";
import type { OpenNetwork } from "./network-navigation.js";
import { createPortal } from "react-dom";
import { useId, useRef, useState, useSyncExternalStore } from "react";
import type { AdhdHost } from "./AdhdBoard.js";
import type { HubConnection, Bot } from "./connection.js";
import type { Preferences } from "./storage.js";
import { AvatarProvider } from "./Avatar.js";
import { BotReferences } from "./BotReferences.js";
import { RuntimeHostContext } from "./RuntimeHost.js";
import { DesktopMenuPortalContext } from "./DesktopMenu.js";
import { WorkspaceFooter, type WorkspaceTool } from "./WorkspaceFooter.js";
import { PreferencesPanel } from "./PreferencesPanel.js";
import { ConnectionPanel } from "./ConnectionPanel.js";
import { FileCenter } from "./FileCenter.js";
import { CapabilitiesPanel } from "./CapabilitiesPanel.js";
import { CapabilityHelpDialog, type CapabilityHelpRequest } from "./CapabilityHelpDialog.js";
import { OperationsPanel } from "./OperationsPanel.js";
import { ScheduledTasks } from "./ScheduledTasks.js";
import { ArchivedConversations } from "./ArchivedConversations.js";
import { useLocale } from "./i18n.js";

export type AdhdToolActions = { manageHosts: OpenNetwork; manageConnections: OpenNetwork; addHost: () => void; createBot: (hostId: string) => void };
type Props = {
  host: AdhdHost; connection: HubConnection; preferences: Preferences; updatePreferences: (value: Preferences) => void;
  actions: AdhdToolActions; navigate: (id: string, createdTitle?: string) => void;
};

/** Reuses host tools without mounting a hidden chat or leaving the board. The
 * caller keys this scope by registration, so a tool can never change hosts. */
export function AdhdWorkspaceTools({ host, connection, preferences, updatePreferences, actions, navigate }: Props) {
  useLocale();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const [menu, setMenu] = useState(false), [view, setView] = useState<WorkspaceTool>();
  const [help, setHelp] = useState<{ request: CapabilityHelpRequest; bot: Bot }>();
  const menuId = useId(), trigger = useRef<HTMLButtonElement>(null);
  const conversations = host.directory?.conversations ?? [], bots = state.bots;
  const listed = listedConversations(conversations), archived = listed.filter(c => c.archived && !c.parentId);
  const close = () => setView(undefined);
  const openConversation = (id: string, title?: string) => { close(); setHelp(undefined); navigate(id, title); };
  return <DesktopMenuPortalContext.Provider value><RuntimeHostContext.Provider value={host.host.name}><AvatarProvider connection={connection} conversations={conversations} directory={host.directory?.bots}><BotReferences bots={bots}>
    <WorkspaceFooter hostName={host.host.name} status={state.status} userId={state.user?.id} archivedCount={archived.length} menuId={menuId} menuOpen={menu} trigger={trigger} toggleMenu={() => setMenu(value => !value)} closeMenu={() => setMenu(false)} open={setView} manageHosts={actions.manageHosts} addHost={actions.addHost}/>
    {createPortal(<>{(view === "settings" || view === "profile") && <PreferencesPanel connection={connection} preferences={preferences} update={updatePreferences} close={close} manageNetwork={(beforeLeave, hostKey, options) => actions.manageHosts(beforeLeave, hostKey ?? connection.identity.hubPublicKey, options)} manageConnections={actions.manageConnections} forget={async () => { close(); actions.manageHosts(); }}/>}
    {view === "connection" && <ConnectionPanel connection={connection} close={close}/>}
    {view === "files" && <FileCenter connection={connection} bots={bots} close={close}/>}
    {view === "capabilities" && <CapabilitiesPanel connection={connection} bots={bots} close={close} help={request => { const bot = bots.find(item => item.id === request.botId); if (bot) setHelp({ request, bot }); }}/>}
    {help && <CapabilityHelpDialog connection={connection} request={help.request} bot={help.bot} close={() => setHelp(undefined)} created={conversation => openConversation(conversation.id, conversation.title)}/>}
    {view === "operations" && <OperationsPanel connection={connection} close={close}/>}
    {view === "schedules" && <ScheduledTasks connection={connection} bots={bots} conversations={listed} close={close} openConversation={openConversation} newBot={() => { close(); actions.createBot(host.host.id); }}/>}
    {view === "archives" && <ArchivedConversations connection={connection} conversations={listed} close={close} open={openConversation}/>}
    </>, document.body)}
  </BotReferences></AvatarProvider></RuntimeHostContext.Provider></DesktopMenuPortalContext.Provider>;
}
