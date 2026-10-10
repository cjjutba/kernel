import os, re
# On claude.ai the canvas builds into the artifact; in the repo it builds into design/canvas/project from the templates beside this file.
HERE=os.path.dirname(os.path.abspath(__file__))
SANDBOX='/mnt/user-data/outputs/artifacts/c04e8bb9-d254-4b60-874a-89c3b4ccb4d2/project/'
P=SANDBOX if os.path.isdir(SANDBOX) else os.path.join(HERE,'..','project')+'/'
T='/home/claude/tpl/' if os.path.isdir('/home/claude/tpl/') else os.path.join(HERE,'templates')+'/'
rd=lambda n: open(T+n).read()
helmet=rd('_helmet.html').replace('.cmp input::placeholder{color:#8a8f98}','input::placeholder,textarea::placeholder{color:#8a8f98}')
foot_t=rd('_footer.html'); side_t=rd('_sidebar.html'); rooms=rd('_rooms.html')
EMPTY='<p style="margin: 0; padding: 4px 8px 0; font-size: 12.5px; line-height: 1.5; color: #8a8f98">No rooms yet. <a href="NewRoom.dc.html" style="color: #d0d6e0">Create one</a></p>'
PILL='''<a href="WhatsNew.dc.html" style="display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px; border-radius: 999px; border: 1px solid #3a3c42; color: #f7f8f8; text-decoration: none; font-size: 12px; font-weight: 500"><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"></path></svg>Update ready</a>
'''
RAIL='''<nav aria-label="Sidebar" style="width: 64px; flex-shrink: 0; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 0 6px">
<div style="height: 42px; display: flex; align-items: center; gap: 6px"><span aria-hidden="true" style="width: 11px; height: 11px; border-radius: 50%; background: #ff5f57"></span><span aria-hidden="true" style="width: 11px; height: 11px; border-radius: 50%; background: #febc2e"></span><span aria-hidden="true" style="width: 11px; height: 11px; border-radius: 50%; background: #28c840"></span></div>
<a href="CommandPalette.dc.html" aria-label="Search" style="width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; color: #8a8f98"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="7" cy="7" r="4.3"></circle><path d="m10.3 10.3 3.2 3.2"></path></svg></a>
<a href="Home.dc.html" aria-label="Home" style="width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; color: #8a8f98"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.8 7 8 2.8 13.2 7v5.7a.5.5 0 0 1-.5.5H9.6V9.8H6.4v3.4H3.3a.5.5 0 0 1-.5-.5Z"></path></svg></a>
<a href="Inbox.dc.html" aria-label="Inbox" style="width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; color: #8a8f98"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.5 9 4.2 3.2h7.6L13.5 9v3.3a.9.9 0 0 1-.9.9H3.4a.9.9 0 0 1-.9-.9Z"></path><path d="M2.5 9h3.1l.8 1.6h3.2l.8-1.6h3.1"></path></svg></a>
<a href="WorkspaceLead.dc.html" aria-label="Client A" style="width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; background: #1c1d21; color: #f7f8f8; font-size: 11px; font-weight: 600">A</a>
<a href="WorkspaceLead.dc.html" aria-label="Client B" style="width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; color: #d0d6e0; font-size: 11px; font-weight: 600">B</a>
</nav>'''
def sidebar(active, empty=False, menu=None):
    s=side_t.replace('%%ROOMS%%', EMPTY if empty else rooms)
    s=s.replace('%%INBOXBADGE%%','' if empty else '<span style="font-size: 12px; color: #8a8f98">3</span>')
    for key,val in [('ROOMSMENU','rooms'),('ROOMMENU','room'),('ACCTMENU','acct')]:
        s=s.replace('%%'+key+'%%',' open' if menu==val else '')
    s=s.replace('%%ROOMSSHOW%%',' show' if menu=='rooms' else '').replace('%%ROOMSHOW%%',' show' if menu=='room' else '')
    # D-104 hid the floor and the Board and D-108 dropped Try. D-139 lists the Lead's open chats under a room, each with its workspaces,
    # and moves Team into the room menu, so no row is Team's: 'lead' marks the Lead's current chat and 'ws' the current workspace.
    for k in ['search','home','inbox','history','lead','ws']:
        on=k==active
        s=s.replace('%%'+k+'C%%',' aria-current="page"' if on else '')
        s=s.replace('%%'+k+'S%%','#d0d6e0' if on else '#8a8f98')
        s=s.replace('%%'+k+'%%','background: #1c1d21; color: #f7f8f8;' if on else 'color: #d0d6e0;')
    assert '%%' not in s, s[s.index('%%')-60:s.index('%%')+40]
    return s
out=[]
HOOKS_DOWN='''<a href="CheckHooks.dc.html" style="display: inline-flex; align-items: center; gap: 8px; height: 24px; padding: 0 6px; margin-left: -6px; border-radius: 6px; color: #d0d6e0; text-decoration: none"><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5v3M10 2.5v3M4.5 5.5h7V8a3.5 3.5 0 0 1-7 0ZM8 11.5V14"></path></svg>Hooks down<span style="margin-left: 4px; color: #f7f8f8; text-decoration: underline">Check hooks</span></a>'''
def emit(name, t, a, empty=False, menu=None, rail=False, light=False, update=False, hooks_down=False):
    t=t.replace('<!--HELMET-->',helmet)
    if '<!--SIDEBAR-->' in t: t=t.replace('<!--SIDEBAR-->',RAIL if rail else sidebar(a,empty,menu))
    t=t.replace('<!--FOOTER-->',foot_t.replace('%%ASKOPEN%%',' open' if menu=='ask' else '').replace('%%UPDATEPILL%%', PILL if update else '').replace('%%HOOKS%%', HOOKS_DOWN if hooks_down else '<span></span>'))
    assert '<!--' not in t and '%%' not in t, (name, t[t.find('%%')-80:t.find('%%')+40])
    assert 'Agent Office' not in t, name
    if light: t=lighten(t)
    open(P+name+'.dc.html','w').write(t); out.append(name)
LMAP={'#08090a':'#f3f3f4','#0f1011':'#ffffff','#0b0c0d':'#fafafa','#0a0b0c':'#f5f5f6','#0c0d0e':'#f6f6f7','#111214':'#f6f6f7','#121315':'#f6f6f7','#141516':'#f4f4f5','#141517':'#f4f4f5','#141518':'#f0f0f2','#16171a':'#efeff1','#17181a':'#ececee','#18191a':'#efeff1','#18191b':'#efeff1','#18191c':'#eeeef0','#1a1b1e':'#e8e8eb','#1c1d20':'#eaeaed','#1c1d21':'#eaeaed','#1d1e22':'#e4e4e7','#1f2024':'#e4e4e7','#222327':'#e6e6e9','#232428':'#e6e6e9','#23252a':'#dedee2','#24252a':'#e2e2e5','#26272b':'#e0e0e4','#26272b':'#e0e0e4','#2a2b30':'#d6d6db','#2e3036':'#d2d2d8','#3a3c42':'#c4c4ca','#3e3e44':'#bdbdc3','#4a4c52':'#a8a8b0','#62666d':'#9a9da4','#6b7079':'#8d9098','#8a8f98':'#6b6f77','#b7bcc4':'#4a4d54','#d0d6e0':'#3a3d44','#e3e5e8':'#1f2023','#f7f8f8':'#18191b'}
def lighten(t):
    return re.sub(r'#[0-9a-fA-F]{6}\b', lambda m: LMAP.get(m.group(0).lower(), m.group(0)), t)
simple={'Home':'home','Rooms':None,'NewRoom':None,'HomeEmpty':'home','Welcome':None,'CommandPalette':'search','Team':None,'AgentProfile':None,'History':'history','LoadingApp':None}
for n,a in simple.items(): emit(n, rd(n+'.dc.html'), a, empty=(n=='HomeEmpty'))
emit('WhatsNew', rd('WhatsNew.dc.html'), 'home', update=True)
emit('UpdateReady', rd('Home.dc.html'), 'home', update=True)
emit('HomeLight', rd('Home.dc.html'), 'home', light=True)
emit('SidebarRoomsMenu', rd('Home.dc.html'), 'home', menu='rooms')
emit('AccountMenu', rd('Home.dc.html'), 'home', menu='acct')
# The floor and Board screens (Main, Floor*, Board, BoardEmpty, TaskDetail) are hidden (D-104). Their pages keep the sidebar they
# were drawn with and are not rebuilt, so they still show the screens as they were. Board.dc.html and Main.dc.html stay as templates.
ib=rd('Inbox.dc.html')
for n,v in [('Inbox','none'),('InboxEmpty','empty')]: emit(n, ib.replace('%%INBOX%%',v), 'inbox')
tr=rd('_Try.dc.html')
for n,mode,title in [('ConnectRepo','repo','Connect a repo'),('OpenFolder','folder','Open a folder'),('CheckHooks','hooks','Check hooks')]:
    emit(n, tr.replace('%%MODE%%',mode).replace('%%TITLE%%',title), None)
# The app's fixtures open the room menu over Team and Ask Rowan over Home.
emit('SidebarRoomMenu', rd('Team.dc.html'), None, menu='room')
emit('QuickAsk', rd('Home.dc.html'), 'home', menu='ask')
ws=rd('Workspace.dc.html')
WS=[('Workspace','done'),('WorkspaceMerged','merged'),('WorkspacePaste','paste'),('WorkspaceRunning','running'),('WorkspacePlan','plan'),('WorkspacePerm','perm'),('WorkspaceQuestion','question'),('WorkspaceInterrupted','interrupted'),('WorkspaceError','error'),('WorkspaceSessionLimit','session'),('WorkspaceWeeklyLimit','weekly'),('WorkspaceModelLimit','model'),('WorkspaceContext','context'),('WorkspaceOverloaded','overloaded'),('WorkspaceOffline','offline'),('WorkspaceSignedOut','signedout'),('WorkspaceSetupFailed','setupfail'),('WorkspaceHooksDown','hooks'),('WorkspaceNewChat','newchat'),('WorkspaceTerminal','terminal'),('WorkspaceLead','lead'),('WorkspaceHire','hire'),
    ('WorkspaceToolCalls','tools'),('WorkspaceCheckpoints','checkpoints'),('WorkspaceCIFailed','cifail'),('WorkspaceChangesRequested','changes'),('WorkspaceDraftPR','draft'),('WorkspacePRClosed','closed'),('WorkspacePRMenu','prmenu'),('WorkspaceFile','file'),('WorkspaceMention','mention'),('WorkspaceSlash','slash'),('WorkspaceActions','actions'),('WorkspaceQueued','queued'),('WorkspaceTabMenu','tabmenu'),('WorkspaceHunks','hunks'),('WorkspaceToast','toast'),('WorkspaceLoading','loading')]
for n,sc in WS: emit(n, ws.replace('%%SCENARIO%%',sc), 'lead' if sc in ('lead','hire') else 'ws', hooks_down=sc=='hooks')
emit('WorkspaceFocus', ws.replace('%%SCENARIO%%','focus'), 'ws', rail=True)
emit('WorkspaceLight', ws.replace('%%SCENARIO%%','done'), 'ws', light=True)
nw=rd('NewWorkspace.dc.html')
for n,m in [('NewWorkspace','none'),('NewWorkspaceBranch','branch'),('NewWorkspaceFrom','from'),('NewWorkspaceModel','model'),('NewWorkspacePlus','plus')]:
    emit(n, nw.replace('%%MENU%%',m), None)
na=rd('NewAgent.dc.html')
for n,st in [('NewAgent','describe'),('NewAgentDraft','draft'),('NewAgentDone','done')]: emit(n, na.replace('%%STEP%%',st), None)
cf=rd('Confirm.dc.html')
for n,k in [('ConfirmArchive','archive'),('ConfirmRemoveRoom','remove'),('ConfirmDiscard','discard'),('ConfirmRetire','retire')]: emit(n, cf.replace('%%KIND%%',k), 'ws' if k in ('archive','discard') else None)
su=rd('Setup.dc.html')
for n,k in [('SetupClaudeMissing','missing'),('SetupClaudeOld','old'),('SetupTeamsOff','teams'),('SetupGhSignedOut','gh'),('SetupPortBusy','port'),('RoomSetup','room')]: emit(n, su.replace('%%CASE%%',k), None)
se=rd('Settings.dc.html')
for n,pg in [('Settings','general'),('SettingsAppearance','appearance'),('SettingsNotifications','notifications'),('SettingsAccount','account'),('SettingsShortcuts','shortcuts'),('SettingsModels','models'),('SettingsTeam','team'),('SettingsPermissions','permissions'),('SettingsSkills','skills'),('SettingsGit','git'),('SettingsScripts','scripts'),('SettingsPRs','prs'),('SettingsFiles','files'),('SettingsHooks','hooks'),('SettingsIntegrations','integrations'),('SettingsExperimental','experimental'),('SettingsAbout','about'),('SettingsRoom','room-a')]:
    emit(n, se.replace('%%PAGE%%',pg), None)
print(len(out))
if P==SANDBOX: open('/home/claude/built.txt','w').write('\n'.join(out))
p=P+'InboxEmpty.dc.html'; t=open(p).read()
t=t.replace('<span style="flex: 1">Inbox</span><span style="font-size: 12px; color: #8a8f98">3</span>','<span style="flex: 1">Inbox</span>')
open(p,'w').write(t)
