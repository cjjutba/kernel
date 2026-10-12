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
def fold_rooms(r):
    # KERNEL-205: a chat that started workspaces folds like a room. Its workspaces are hidden and it shows the question icon,
    # because the hidden invoice-schema needs you.
    lines=r.split('\n')
    keep=[l for l in lines if 'class="row"' not in l or not ('>invoice-table<' in l or '>invoice-schema<' in l)]
    ask=re.search(r'<svg[^>]*>(?:(?!</svg>).)*M13\.5 8a5\.5 5\.5 0 1 1-11 0.*?</svg>', next(l for l in lines if 'aria-label="invoice-schema, Needs you"' in l)).group(0)
    out=[]
    for l in keep:
        if 'aria-label="Invoice table and empty states, Working"' in l:
            l=l.replace('aria-label="Invoice table and empty states, Working"','aria-label="Invoice table and empty states, Needs you"')
            l,n=re.subn(r'<span aria-hidden="true" style="width: 16px; height: 16px; flex-shrink: 0;.*?</span></span>', lambda m: ask, l, count=1)
            assert n==1
        out.append(l)
    return '\n'.join(out)
rooms_folded=fold_rooms(rooms)
# KERNEL-258: a room can show an icon in place of its letter. A GitHub avatar is drawn in grayscale so the sidebar stays monochrome.
# Only a page that passes icons={'Client B': avatar(16)} changes; every other page gets the rooms exactly as _rooms.html has them.
def avatar(px): return '<svg width="%d" height="%d" viewBox="0 0 56 56" aria-hidden="true" style="display: block"><rect width="56" height="56" fill="#3a3c42"></rect><path d="M16 8h24v8H16zM8 16h16v8H8zM32 16h16v8H32zM8 24h8v8H8zM24 24h8v8H24zM40 24h8v8H40zM8 32h40v8H8zM8 40h8v8H8zM40 40h8v8H40z" fill="#b7bcc4"></path></svg>'%(px,px)
def room_icons(r, icons):
    for room,svg in icons.items():
        m=re.search(r'(<span aria-hidden="true" style="[^"]*?)(font-size: 10px; font-weight: 600">)\w(</span><span style="flex: 1">'+re.escape(room)+'</span>)', r)
        assert m, room
        r=r[:m.start()]+m.group(1)+'overflow: hidden; '+m.group(2)+svg+m.group(3)+r[m.end():]
    return r
def sidebar(active, empty=False, menu=None, fold=False, icons=None, rows_html=None):
    base=side_t
    if rows_html is not None:
        # KERNEL-336: the room list scrolls in the app (sidebar.css), so a page with its own rows clips them in a box instead of pushing the footer off the window.
        scroll='%%ROOMS%%\n\n<div style="flex: 1"></div>'
        assert scroll in base
        base=base.replace(scroll,'<div style="flex: 1; min-height: 0; overflow: hidden">%%ROOMS%%</div>')
    s=base.replace('%%ROOMS%%', EMPTY if empty else rows_html if rows_html is not None else room_icons(rooms_folded if fold else rooms, icons or {}))
    s=s.replace('%%INBOXBADGE%%','' if empty else '<span style="font-size: 12px; color: #8a8f98">3</span>')
    for key,val in [('ROOMSMENU','rooms'),('ROOMMENU','room'),('ACCTMENU','acct')]:
        s=s.replace('%%'+key+'%%',' open' if menu==val else '')
    s=s.replace('%%ROOMSSHOW%%',' show' if menu=='rooms' else '').replace('%%ROOMSHOW%%',' show' if menu=='room' else '')
    # D-104 hid the floor and the Board and D-108 dropped Try. D-139 lists the Lead's open chats under a room, each with its workspaces,
    # and moves Team into the room menu, so no row is Team's: 'lead' marks the Lead's current chat and 'ws' the current workspace.
    for k in ['search','home','inbox','issues','history','lead','ws']:
        on=k==active
        s=s.replace('%%'+k+'C%%',' aria-current="page"' if on else '')
        s=s.replace('%%'+k+'S%%','#d0d6e0' if on else '#8a8f98')
        s=s.replace('%%'+k+'%%','background: #1c1d21; color: #f7f8f8;' if on else 'color: #d0d6e0;')
    assert '%%' not in s, s[s.index('%%')-60:s.index('%%')+40]
    return s
out=[]
HOOKS_DOWN='''<a href="CheckHooks.dc.html" style="display: inline-flex; align-items: center; gap: 8px; height: 24px; padding: 0 6px; margin-left: -6px; border-radius: 6px; color: #d0d6e0; text-decoration: none"><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5v3M10 2.5v3M4.5 5.5h7V8a3.5 3.5 0 0 1-7 0ZM8 11.5V14"></path></svg>Hooks down<span style="margin-left: 4px; color: #f7f8f8; text-decoration: underline">Check hooks</span></a>'''
# KERNEL-401: a GitHub rate limit holding Kernel's PR reads off. A word with a muted time, not a link, beside where Hooks down shows.
GH_PAUSED='''<span role="status" style="display: inline-flex; align-items: center; gap: 8px; height: 24px; padding: 0 6px; margin-left: -6px; border-radius: 6px; color: #d0d6e0"><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v10M11 3v10"></path></svg>GitHub paused<span style="margin-left: 4px; color: #8a8f98">PRs update at 3:41 PM</span></span>'''
def emit(name, t, a, empty=False, menu=None, rail=False, light=False, update=False, hooks_down=False, gh_paused=False, fold=False, icons=None, rows_html=None):
    t=t.replace('<!--HELMET-->',helmet)
    if '<!--SIDEBAR-->' in t: t=t.replace('<!--SIDEBAR-->',RAIL if rail else sidebar(a,empty,menu,fold,icons,rows_html))
    t=t.replace('<!--FOOTER-->',foot_t.replace('%%ASKOPEN%%',' open' if menu=='ask' else '').replace('%%UPDATEPILL%%', PILL if update else '').replace('%%HOOKS%%', HOOKS_DOWN if hooks_down else GH_PAUSED if gh_paused else '<span></span>'))
    assert '<!--' not in t and '%%' not in t, (name, t[t.find('%%')-80:t.find('%%')+40])
    assert 'Agent Office' not in t, name
    if light: t=lighten(t)
    open(P+name+'.dc.html','w').write(t); out.append(name)
LMAP={'#08090a':'#f3f3f4','#0f1011':'#ffffff','#0b0c0d':'#fafafa','#0a0b0c':'#f5f5f6','#0c0d0e':'#f6f6f7','#111214':'#f6f6f7','#121315':'#f6f6f7','#141516':'#f4f4f5','#141517':'#f4f4f5','#141518':'#f0f0f2','#16171a':'#efeff1','#17181a':'#ececee','#18191a':'#efeff1','#18191b':'#efeff1','#18191c':'#eeeef0','#1a1b1e':'#e8e8eb','#1c1d20':'#eaeaed','#1c1d21':'#eaeaed','#1d1e22':'#e4e4e7','#1f2024':'#e4e4e7','#222327':'#e6e6e9','#232428':'#e6e6e9','#23252a':'#dedee2','#24252a':'#e2e2e5','#26272b':'#e0e0e4','#26272b':'#e0e0e4','#2a2b30':'#d6d6db','#2e3036':'#d2d2d8','#3a3c42':'#c4c4ca','#3e3e44':'#bdbdc3','#4a4c52':'#a8a8b0','#62666d':'#9a9da4','#6b7079':'#8d9098','#8a8f98':'#6b6f77','#b7bcc4':'#4a4d54','#d0d6e0':'#3a3d44','#e3e5e8':'#1f2023','#f7f8f8':'#18191b'}
def lighten(t):
    return re.sub(r'#[0-9a-fA-F]{6}\b', lambda m: LMAP.get(m.group(0).lower(), m.group(0)), t)
# Every screen list below keeps one screen per line, with a trailing comma, so two PRs that add screens don't edit the same line.
simple={
    'Home':'home',
    'Rooms':None,
    'NewRoom':None,
    'HomeEmpty':'home',
    'Welcome':None,
    'CommandPalette':'search',
    'Team':None,
    'TeamOwnAgents':None,
    'AgentProfile':None,
    'AgentProfileBuiltIn':None,
    'RoomSetupTeam':None,
    'History':'history',
    'LoadingApp':None,
}
# KERNEL-301: the palette lists a Shared group only where files were shared. SearchShared draws it; CommandPalette stays as it was.
for n,a in simple.items(): emit(n, rd(n+'.dc.html').replace('%%SHARED%%','off'), a, empty=(n=='HomeEmpty'))
emit('SearchShared', rd('CommandPalette.dc.html').replace('%%SHARED%%','on'), 'search')
emit('WhatsNew', rd('WhatsNew.dc.html'), 'home', update=True)
emit('UpdateReady', rd('Home.dc.html'), 'home', update=True)
emit('HomeLight', rd('Home.dc.html'), 'home', light=True)
emit('SidebarRoomsMenu', rd('Home.dc.html'), 'home', menu='rooms')
emit('SidebarChatFolded', rd('Home.dc.html'), 'home', fold=True)
emit('AccountMenu', rd('Home.dc.html'), 'home', menu='acct')
# KERNEL-258: Client B uses a GitHub avatar. Home shows it in the sidebar and on the room's card, so one room has one icon.
hi=rd('Home.dc.html')
tile='border: 1px solid #2a2b30; background: #1c1d21; font-size: 10.5px; font-weight: 600">{{ r.letter }}</span>'
assert hi.count(tile)==1 and hi.count("{ letter: 'B', name: 'Client B',")==1
hi=hi.replace(tile,'overflow: hidden; '+tile[:-7]+'<sc-if value="{{ r.avatar }}" hint-placeholder-val="{{ false }}">'+avatar(18)+'</sc-if></span>')
hi=hi.replace("{ letter: 'B', name: 'Client B',","{ letter: '', avatar: true, name: 'Client B',")
emit('HomeRoomIcon', hi, 'home', icons={'Client B': avatar(16)})
# The floor and Board screens (Main, Floor*, Board, BoardEmpty, TaskDetail) are hidden (D-104). Their pages keep the sidebar they
# were drawn with and are not rebuilt, so they still show the screens as they were. Board.dc.html and Main.dc.html stay as templates.
ib=rd('Inbox.dc.html')
for n,v in [
    ('Inbox','none'),
    ('InboxEmpty','empty'),
]: emit(n, ib.replace('%%INBOX%%',v), 'inbox')
is_=rd('Issues.dc.html')
for n,st in [
    ('Issues','list'),
    ('IssuesWorking','working'),
    ('IssuesNoRoom','noroom'),
    ('IssuesEmpty','empty'),
    ('IssuesConnect','connect'),
    ('IssuesError','error'),
    ('IssuesGitHub','github'),
    ('IssuesNoTracker','notracker'),
]: emit(n, is_.replace('%%STATE%%',st), 'issues')
tr=rd('_Try.dc.html')
for n,mode,title in [
    ('ConnectRepo','repo','Connect a repo'),
    ('OpenFolder','folder','Open a folder'),
    ('CheckHooks','hooks','Check hooks'),
    # KERNEL-437: why hooks can't be installed, with the one fix for each.
    ('CheckHooksNotWritable','hooks-eacces','Check hooks · folder not writable'),
    ('CheckHooksReadOnly','hooks-erofs','Check hooks · read-only disk'),
    ('CheckHooksSymlink','hooks-symlink','Check hooks · settings file is a link'),
    ('CheckHooksManaged','hooks-managed','Check hooks · managed settings'),
    ('CheckHooksOff','hooks-off','Check hooks · hooks turned off'),
]:
    emit(n, tr.replace('%%MODE%%',mode).replace('%%TITLE%%',title), None)
# The app's fixtures open the room menu over Team and Ask Rowan over Home.
emit('SidebarRoomMenu', rd('Team.dc.html'), None, menu='room')
emit('QuickAsk', rd('Home.dc.html'), 'home', menu='ask')
ws=rd('Workspace.dc.html')
WS=[
    ('Workspace','done'),
    ('WorkspaceMerged','merged'),
    ('WorkspacePaste','paste'),
    ('WorkspaceRunning','running'),
    ('WorkspacePlan','plan'),
    ('WorkspacePerm','perm'),
    ('WorkspacePermReason','permreason'),
    ('WorkspacePermReasonCodex','permreasoncodex'),
    ('WorkspaceQuestion','question'),
    ('WorkspaceQuestionSteps','questionsteps'),
    ('WorkspaceQuestionLong','questionlong'),
    ('WorkspaceQuestionOther','questionother'),
    ('WorkspaceQuestionAnswers','questionanswers'),
    ('WorkspaceInterrupted','interrupted'),
    ('WorkspaceError','error'),
    ('WorkspaceSessionLimit','session'),
    ('WorkspaceWeeklyLimit','weekly'),
    ('WorkspaceModelLimit','model'),
    ('WorkspaceProviderLimit','providerlimit'),
    ('WorkspaceModelPicker','picker'),
    ('WorkspaceContext','context'),
    ('WorkspaceOverloaded','overloaded'),
    ('WorkspaceOffline','offline'),
    ('WorkspaceSignedOut','signedout'),
    ('WorkspaceSetupFailed','setupfail'),
    ('WorkspaceHooksDown','hooks'),
    ('WorkspaceGitHubPaused','ghpaused'),
    ('WorkspaceNewChat','newchat'),
    ('WorkspaceTerminal','terminal'),
    ('WorkspaceLead','lead'),
    ('WorkspaceHire','hire'),
    ('WorkspaceToolCalls','tools'),
    ('WorkspaceCheckpoints','checkpoints'),
    ('WorkspaceCIFailed','cifail'),
    ('WorkspaceChangesRequested','changes'),
    ('WorkspaceDraftPR','draft'),
    ('WorkspacePRClosed','closed'),
    ('WorkspacePRMenu','prmenu'),
    ('WorkspaceFile','file'),
    ('WorkspaceMention','mention'),
    ('WorkspaceSlash','slash'),
    ('WorkspaceActions','actions'),
    ('WorkspaceQueued','queued'),
    ('WorkspaceTabMenu','tabmenu'),
    ('WorkspaceHunks','hunks'),
    ('WorkspaceToast','toast'),
    ('WorkspaceLoading','loading'),
    ('WorkspaceIssue','issue'),
    ('WorkspaceSharedCard','sharedcard'),
    ('WorkspaceSharedHtml','sharedhtml'),
    ('WorkspaceSharedPhone','sharedphone'),
    ('WorkspaceSharedImage','sharedimage'),
    ('WorkspaceSharedMarkdown','sharedmd'),
    ('WorkspaceSharedPdf','sharedpdf'),
    ('WorkspaceSharedVersions','sharedversions'),
    ('WorkspaceSharedCrashed','sharedcrashed'),
    ('WorkspaceSharedPanel','sharedpanel'),
    ('WorkspaceSharedPanelEmpty','sharedpanelempty'),
    ('WorkspaceSharedComment','sharedcomment'),
    ('WorkspaceSharedCommentImage','sharedcommentimage'),
    ('WorkspaceSharedCommentSent','sharedcommentsent'),
    ('WorkspaceSharedCommentArchived','sharedcommentarchived'),
    ('WorkspaceSharedCommentOlder','sharedcommentolder'),
]
for n,sc in WS:
    if n in ('WorkspaceLead','WorkspaceQuestionLong'): continue  # KERNEL-356 and KERNEL-414 draw them with the Lead workspace, below
    emit(n, ws.replace('%%SCENARIO%%',sc), 'lead' if sc in ('lead','hire','sharedpanel','sharedcommentarchived') else 'ws', hooks_down=sc=='hooks', gh_paused=sc=='ghpaused')
emit('WorkspaceFocus', ws.replace('%%SCENARIO%%','focus'), 'ws', rail=True)
# KERNEL-258: the workspace pieces for run scripts, Open preview and terminal presets, drawn in the KERNEL-274 look. The page brings its own sidebar.
wp=rd('WorkspacePanels.dc.html')
for n,sc in [
    ('WorkspaceRunScripts','runscripts'),
    ('WorkspacePreview','preview'),
    ('WorkspaceTerminalPresets','presets'),
]: emit(n, wp.replace('%%SCENARIO%%',sc), None)
emit('WorkspaceLight', ws.replace('%%SCENARIO%%','done'), 'ws', light=True)
nw=rd('NewWorkspace.dc.html')
for n,m in [
    ('NewWorkspace','none'),
    ('NewWorkspaceBranch','branch'),
    ('NewWorkspaceFrom','from'),
    ('NewWorkspaceFromGitHub','from-github'),
    ('NewWorkspaceFromNone','from-none'),
    ('NewWorkspaceModel','model'),
    ('NewWorkspacePlus','plus'),
]:
    emit(n, nw.replace('%%MENU%%',m), None)
na=rd('NewAgent.dc.html')
for n,st in [
    ('NewAgent','describe'),
    ('NewAgentDraft','draft'),
    ('NewAgentDone','done'),
]: emit(n, na.replace('%%STEP%%',st), None)
cf=rd('Confirm.dc.html')
for n,k in [
    ('ConfirmArchive','archive'),
    ('ConfirmRemoveRoom','remove'),
    ('ConfirmDiscard','discard'),
    ('ConfirmRetire','retire'),
    ('TelemetryAsk','telemetry'),
    ('ConfirmIssueTaken','taken'),
    ('ConfirmBypass','bypass'),
]: emit(n, cf.replace('%%KIND%%',k), 'ws' if k in ('archive','discard','bypass') else None)
su=rd('Setup.dc.html')
for n,k in [
    ('SetupClaudeMissing','missing'),
    ('SetupClaudeOld','old'),
    ('SetupGhSignedOut','gh'),
    ('SetupPortBusy','port'),
    # KERNEL-437: the lines B1 and B2 add to the readiness checks, and the room setup that warns before an agent needs to push.
    ('SetupGhIdentity','ghkeyring'),
    ('SetupGhToken','ghtoken'),
    ('SetupShellTimeout','shell'),
    ('SetupBedrock','bedrock'),
    ('RoomSetup','room'),
    ('RoomSetupWarnings','roomwarn'),
    ('SetupPermissions','perm'),
    ('SetupPermissionsNoAuto','permnoauto'),
]: emit(n, su.replace('%%CASE%%',k), None)
se=rd('Settings.dc.html')
# KERNEL-255: Environment, Big terminal and the room icon picker have pages. SettingsEnvironmentAdd is the add form over the room's Environment page.
# KERNEL-188: room pages nest under each room. SettingsTeam, SettingsSkills and SettingsFiles keep their names and draw the room's Agents, Skills and MCP, and Files to copy pages.
for n,pg in [
    ('Settings','general'),
    ('SettingsAppearance','appearance'),
    ('SettingsNotifications','notifications'),
    ('SettingsAccount','account'),
    ('SettingsShortcuts','shortcuts'),
    ('SettingsModels','models'),
    ('SettingsProviders','providers'),
    ('SettingsProvidersCodex','providers-codex'),
    ('SettingsProvidersCodexSignedOut','providers-codex-out'),
    ('SettingsTeam','r-agents'),
    ('SettingsPermissions','permissions'),
    ('SettingsSkills','r-skills'),
    ('SettingsGit','git'),
    ('SettingsScripts','scripts'),
    ('SettingsPRs','prs'),
    ('SettingsFiles','r-files'),
    ('SettingsHooks','hooks'),
    ('SettingsIntegrations','integrations'),
    ('SettingsExperimental','experimental'),
    ('SettingsAbout','about'),
    ('SettingsPrivacy','privacy'),
    ('SettingsRoom','r-general'),
    ('SettingsRoomGit','r-git'),
    # KERNEL-437: the room's push check when it fails, its Disk row while measuring, and the production warning on Files to copy.
    ('SettingsRoomGitPushFailed','r-git-push-failed'),
    ('SettingsRoomGitUnreachable','r-git-unreachable'),
    ('SettingsRoomDiskMeasuring','r-general-measuring'),
    ('SettingsFilesProduction','r-files-production'),
    ('SettingsRoomScripts','r-scripts'),
    ('SettingsRoomInstructions','r-instructions'),
    ('SettingsRoomPermissions','r-permissions'),
    ('SettingsRoomPermissionsMode','r-permissions-mode'),
    ('SettingsEnvironment','env'),
    ('SettingsRoomEnvironment','r-env'),
    ('SettingsEnvironmentAdd','r-env-add'),
    ('SettingsBigTerminal','bigterm'),
    ('SettingsRoomIcon','r-icon'),
    ('SettingsRoomTracker','r-tracker'),
    ('SettingsRoomTrackerNone','r-tracker-none'),
]:
    emit(n, se.replace('%%PAGE%%',pg), None)
# KERNEL-336: grouped chats. A chat is a sidebar row and its tabs are conversations inside it. KERNEL-338 builds the first eleven screens, KERNEL-339 the last two.
# The rows are cut from _rooms.html, so they stay in step with the rest of the canvas. Nothing here changes a page built above.
import json
def gsub(s, a, b):
    assert a in s, 'Template changed, missing: '+a[:80]
    return s.replace(a,b)
rl=rooms.split('\n')
g_first=next(i for i,l in enumerate(rl) if l.startswith('<a href="WorkspaceLead.dc.html"%%leadC%%'))
g_b=next(i for i,l in enumerate(rl) if '>Client B</span>' in l)-1
g_head=rl[:g_first]; g_tail=rl[g_b:]
def g_line(needle): return next(l for l in rl if needle in l)
def g_svg(l): return re.search(r'<svg[\s\S]*?</svg>', l).group(0)
G_SPIN=re.search(r'<span aria-hidden="true" style="width: 16px; height: 16px; flex-shrink: 0;[\s\S]*?</span></span>', g_line('aria-label="Invoice table and empty states, Working"')).group(0)
G_MONO="font-family: 'Geist Mono', ui-monospace, monospace; font-size: 11px"
G_ICON={
    'chat': lambda on: g_svg(g_line('aria-label="Client portal login"')).replace('stroke="#8a8f98"','stroke="%s"'%('#d0d6e0' if on else '#8a8f98')),
    'ask': lambda on: g_svg(g_line('aria-label="invoice-schema, Needs you"')),
    'spin': lambda on: G_SPIN,
    'branch': lambda on: g_svg(g_line('>invoice-table<')).replace('stroke="%%wsS%%"','stroke="%s"'%('#d0d6e0' if on else '#8a8f98')),
    'pr': lambda on: g_svg(g_line('aria-label="org-invites, pull request open"')),
}
G_WORD={'chat':'', 'ask':', Needs you', 'spin':', Working'}
def g_row(label, aria, icon, right, pad, on, hover=False, title=False, href='Workspace.dc.html'):
    bg='background: #1c1d21; color: #f7f8f8;' if on else 'background: #141518; color: #d0d6e0;' if hover else 'color: #d0d6e0;'
    return ('<a href="%s"%s class="row" aria-label="%s"%s style="display: flex; align-items: center; gap: 10px; height: 30px; padding: 0 8px 0 %dpx; border-radius: 6px; text-decoration: none; %s">%s<span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">%s</span>%s</a>'
        %(href, ' aria-current="page"' if on else '', aria, ' title="%s"'%label if title else '', pad, bg, icon, label, right))
def g_ws(w, pad, on):
    if w.get('pr'): right='<span style="%s; color: #8a8f98">%s</span>'%(G_MONO, w['pr'])
    else:
        n,d=w['stat']
        right='<span style="%s"><span style="color: #4cb782">+%d</span>%s</span>'%(G_MONO, n, ' <span style="color: #eb5757">-%d</span>'%d if d else '')
    return g_row(w['name'], w['name']+(', pull request open' if w.get('pr') else ''), G_ICON[w['icon']](on), right, pad, on)
G_W={
    'renderer':{'name':'invoice-pdf-renderer','icon':'branch','stat':(188,0)},
    'button':{'name':'invoice-pdf-button','icon':'pr','pr':'#43'},
    'tests':{'name':'invoice-pdf-tests','icon':'branch','stat':(138,9)},
    'table':{'name':'invoice-table','icon':'branch','stat':(412,38)},
    'schema':{'name':'invoice-schema','icon':'branch','stat':(54,6)},
    'org':{'name':'org-invites','icon':'pr','pr':'#41'},
}
G_TABS={'a1':'Export invoices as PDF','a2':"How is Kai's PR going?",'a3':'One PDF per client','b1':'Invoice table and empty states','b2':'Empty state copy','c1':'Client portal login','c2':'Fix the login redirect','d1':'Seed realistic demo data','n2':'Add CSV export','n3':'New tab','q1':"What's the status of T-15? Who is blocked?",'q2':'Which tests cover the PDF fonts?'}
G_CHATS={'a':('Export invoices as PDF',['renderer','button','tests']),'b':('Invoice table and empty states',['table','schema']),'c':('Client portal login',[]),'d':('Seed realistic demo data',[]),'e':('Add CSV export',[])}
# One row per chat, then the workspaces its tabs handed off, then the unowned ones. glyph: chat id -> 'spin' | 'ask'. on: a chat id or a workspace key. hover: a chat id.
def g_rows(chats=('a','b','c','d'), glyph=None, on=None, hover=None, unowned=('org',)):
    items=[]; ids=[]
    for c in chats:
        title,wss=G_CHATS[c]; gl=(glyph or {}).get(c,'chat')
        items.append(g_row(title, title+G_WORD[gl], G_ICON[gl](on==c), '', 20, on==c, hover==c, True, 'WorkspaceLead.dc.html')); ids.append(c)
        for k in wss: items.append(g_ws(G_W[k],32,on==k)); ids.append(k)
    for k in unowned: items.append(g_ws(G_W[k],20,on==k)); ids.append(k)
    return '\n'.join(g_head+items+g_tail), ids
# The first row under the Client A header sits 290 + 31px from the top: the same 30px row and 1px gap the template draws.
def g_top(ids, k): return 290+31*(ids.index(k)+1)
def g_tab(i, **x): return dict(id=i, kind='chat', title=G_TABS[i], **x)
G_FILE={'id':'f1','kind':'file','title':'table.tsx'}
def U(t): return {'kind':'user','parts':[{'t':t}]}
G_STEPS=['T-15a PDF renderer with embedded fonts · Noor','T-15b Download PDF in the row actions · Kai','T-15c Snapshot tests for three invoice types · Ivy','T-15d Review each PR as it lands · Theo']
G_PLAN=[U('Add PDF export to invoices. Spec first.'),
    {'kind':'thinking','text':'Renderer, button, tests and review can run in parallel.'},
    {'kind':'tool','text':'Read the invoices module','cmd':'cat src/app/invoices/page.tsx'},
    {'kind':'tool','text':'Write the plan','cmd':'cat > plans/t-15-invoice-pdf.md'},
    {'kind':'ai','text':'I split PDF export into four tasks that can run in parallel.'},
    {'kind':'card','title':'Plan for T-15','sub':'Approved by you at 10:12','steps':G_STEPS},
    {'kind':'ai','text':'Handed off. Noor has the renderer, Kai has the button and Ivy has the tests. Theo reviews each PR as it lands.'}]
G_ASK1=[U("What's the status of T-15? Who is blocked?"),
    {'kind':'tool','text':"List this chat's workspaces",'cmd':'kernel workspaces'},
    {'kind':'ai','text':"Nobody is blocked. Noor is still on the renderer, Kai's PR is open and Ivy waits on the renderer for the fixtures."},
    {'kind':'meta','text':'6s · 10:49'}]
G_ASK2=[U('Which tests cover the PDF fonts?'),
    {'kind':'thinking','text':'Ivy owns the snapshot tests. I should check what they assert.'},
    {'kind':'tool','text':'Search the tests','cmd':'rg -n "font" tests'},
    {'kind':'ai','text':"Ivy's snapshot tests in invoice-pdf.spec.ts check the embedded fonts for all three invoice types. Noor's renderer has no unit test of its own yet."},
    {'kind':'meta','text':'8s · 10:52'}]
G_SHARED=[U("How is Kai's PR going?"),
    {'kind':'tool','text':"List this chat's workspaces",'cmd':'kernel workspaces'},
    {'kind':'tool','text':'Read the approved plan','cmd':'cat plans/t-15-invoice-pdf.md'},
    {'kind':'ai','text':"Kai's PR is open as #43 on invoice-pdf-button. Checks pass and Theo is reviewing it. Here is where your other workspaces in this chat stand."},
    {'kind':'card','title':'Your workspaces in this chat','code':['invoice-pdf-renderer  Noor  working','invoice-pdf-button    Kai   PR #43 open','invoice-pdf-tests     Ivy   waiting on the renderer']},
    {'kind':'card','title':'From the plan you approved in the first tab','steps':G_STEPS[:3]},
    {'kind':'meta','text':'11s · 10:56'}]
G_TABLE=[U('Build the invoice table with sorting, plus the empty, loading and error states.'),
    {'kind':'thinking','text':'The table and the schema change are independent. Kai and Noor can start together.'},
    {'kind':'tool','text':'Write the plan','cmd':'cat > plans/t-14-invoice-table.md'},
    {'kind':'ai','text':'Kai has the table and its states. Noor has the schema change the table needs. I will tell you when either opens a PR.'},
    {'kind':'tool','text':'Check on Kai and Noor','cmd':'kernel workspaces'}]
G_NEW=[U('Add CSV export next to the PDF one. Spec first.'),
    {'kind':'thinking','text':'PDF export already lives in the row actions. CSV can sit in the same menu.'},
    {'kind':'tool','text':'Read the invoices module','cmd':'cat src/app/invoices/page.tsx'}]
# The workspace is the room's one Lead workspace (D-139), so every Lead screen draws the same header and the same panel.
G_NO_CHANGES="v.hasChanges = false; v.noChanges = true; v.rtabs[2].count = '0';"
G_ICONS={'plan':'<rect x="3" y="2.5" width="10" height="11" rx="2"></rect><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3"></path>',
    'team':'<circle cx="6" cy="6" r="2.2"></circle><path d="M2.5 13c.4-2 1.8-3 3.5-3s3.1 1 3.5 3"></path><path d="M10.5 4.2a2 2 0 0 1 0 3.6M11.5 10.2c1 .4 1.7 1.3 2 2.8"></path>',
    'pr':'<circle cx="5" cy="4" r="1.5"></circle><circle cx="5" cy="12" r="1.5"></circle><circle cx="11" cy="12" r="1.5"></circle><path d="M5 5.5v5M11 10.5V6.5a2 2 0 0 0-2-2H7.5"></path>'}
# The new tab state is KERNEL-274's NewChat with the word "tab": Rowan's title, subtitle and three suggestions. The centered composer is not built.
G_SUGGEST=''.join('<button type="button" style="display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 12px; border: 1px solid #23252a; border-radius: 8px; background: transparent; color: #d0d6e0; font-family: inherit; font-size: 12.5px; cursor: pointer"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="#8a8f98" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">%s</svg>%s</button>'%(G_ICONS[k],l) for k,l in [('plan','Plan the next issues from Linear'),('team','Who is blocked right now?'),('pr','Review the open pull requests')])
# The Team update card the way KERNEL-274 draws it (TeamUpdate.png), plus the line that says which tab the update was meant for.
G_UPDATE='''<sc-if value="{{ m.isUpdate }}" hint-placeholder-val="{{ false }}"><section aria-label="Team update from Kernel" style="border-radius: 10px; border: 1px solid #23252a; overflow: hidden">
<div style="display: flex; align-items: center; gap: 6px; padding: 9px 16px; border-bottom: 1px solid #1a1b1e; font-size: 12px"><span style="font-weight: 500; color: #8a8f98">Team update</span><span style="color: #62666d">from Kernel</span></div>
<div style="padding: 10px 16px 0; font-size: 12px; color: #8a8f98">From "Export invoices as PDF", a tab you closed</div>
<div style="padding: 9px 16px 14px">
<div style="display: flex; align-items: baseline; gap: 8px; min-width: 0"><span style="flex-shrink: 0; font-size: 13px; font-weight: 500; color: #f7f8f8">Kai</span><span style="flex-shrink: 0; font-family: 'Geist Mono', ui-monospace, monospace; font-size: 11.5px; color: #62666d">T-15b</span><span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: #d0d6e0">Download PDF in the row actions</span><a href="Workspace.dc.html" aria-label="Open Kai's workspace for T-15b" style="flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: #8a8f98; text-decoration: none">Open<svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h6v6M12 4l-7 7"></path></svg></a></div>
<div style="margin-top: 3px; font-size: 12.5px; color: #8a8f98">Finished a turn<span style="margin: 0 6px; color: #62666d">·</span>Opened PR #43</div>
<p style="margin: 9px 0 0; font-size: 13px; line-height: 1.55; color: #b7bcc4">PR #43 is ready to merge. Checks pass and Theo approved it.</p>
</div></section></sc-if>
'''
def g_patch(t, js):
    end=t.rindex('</script>')
    return t[:end]+js+t[end:]
# KERNEL-356: the Lead's workspace after KERNEL-354 and KERNEL-355. Rowan works in its own worktree, so the header reads lead with
# "latest main", the Create PR button is gone, and the right panel opens on a PRs tab under the ready band from LeadPrs.
LEAD_BADGE='latest main'
L_OPEN='<svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h6v6M12 4l-7 7"></path></svg>'
L_PRS=[('Kai','T-15b','#43','Download PDF in the row actions',96,12),('Kai','T-09','#41','Org invites',212,34)]
def lead_pr(name,key,n,title,add,dele):
    return ('<li style="padding: 5px 14px 7px; border-top: 1px solid #1a1b1e">'
      '<div style="display: flex; align-items: center; gap: 8px; height: 24px"><span style="font-size: 13px; font-weight: 500; color: #f7f8f8">%s</span>'
      '<span style="font-family: \'Geist Mono\', ui-monospace, monospace; font-size: 11.5px; color: #62666d">%s</span>'
      '<span style="font-family: \'Geist Mono\', ui-monospace, monospace; font-size: 11.5px; color: #62666d">%s</span>'
      '<span style="margin-left: auto; display: flex; align-items: center; gap: 12px">'
      '<button type="button" aria-label="Merge PR %s" style="display: inline-flex; align-items: center; height: 24px; padding: 0 9px; border-radius: 6px; border: 1px solid #33704f; background: #1d3b2c; color: #a3e8c3; font-family: inherit; font-size: 12px; font-weight: 500; cursor: pointer">Merge</button>'
      '<button type="button" aria-label="Open %s\'s workspace for %s" style="display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; color: #8a8f98; font-family: inherit; font-size: 12px; cursor: pointer">Open%s</button></span></div>'
      '<div style="font-size: 13px; line-height: 18px; color: #d0d6e0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">%s</div>'
      '<div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; line-height: 16px; color: #8a8f98"><span style="color: #4cb782">Theo approved</span>'
      '<span style="font-family: \'Geist Mono\', ui-monospace, monospace; font-size: 11px; font-variant-numeric: tabular-nums"><span style="color: #4cb782">+%d</span> <span style="color: #eb5757">-%d</span></span></div></li>')%(name,key,n,n,name,key,L_OPEN,title,add,dele)
def lead_list(rows):
    return ('<sc-if value="{{ rt.prs }}" hint-placeholder-val="{{ true }}">\n<div aria-label="Pull requests" style="flex: 1; min-height: 0; overflow: hidden">\n'
      '<div style="display: flex; align-items: baseline; gap: 6px; padding: 8px 14px 5px; font-size: 12px; color: #62666d"><h3 style="margin: 0; font-size: 12px; font-weight: 500; color: #8a8f98">Ready to merge</h3><span style="font-family: \'Geist Mono\', ui-monospace, monospace">%d</span></div>\n'
      '<ul style="list-style: none; margin: 0; padding: 0">'%len(rows)+''.join(lead_pr(*r) for r in rows)+'</ul>\n</div>\n</sc-if>\n')
def lead_band(n):
    return ('<button type="button" aria-label="%d ready to merge, open the PRs tab" style="width: 100%%; height: 44px; flex-shrink: 0; box-sizing: border-box; display: flex; align-items: center; gap: 7px; padding: 0 10px 0 12px; border: 0; border-bottom: 1px solid #22432f; background: #15281f; color: #62d69d; font-family: inherit; text-align: left; cursor: pointer">'
  '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="4" r="1.5"></circle><circle cx="5" cy="12" r="1.5"></circle><circle cx="11" cy="12" r="1.5"></circle><path d="M5 5.5v5M11 10.5V6.5a2 2 0 0 0-2-2H7.5"></path><path d="M8.8 3.2 7.5 4.5l1.3 1.3"></path></svg>'
  '<span style="font-size: 12.5px; font-weight: 500">%d ready to merge</span>'
  '<span style="margin-left: auto; display: inline-flex"><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"></path></svg></span></button>\n')%(n,n)
L_HIDE='<button type="button" aria-label="Hide panel" style="width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 7px; background: none; color: #8a8f98; cursor: pointer"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3" width="11" height="10" rx="2"></rect><path d="M10 3v10"></path></svg></button>\n'
def lead_workspace(t, rows=L_PRS):
    # The header spans the chat column only, as in LeadPrs; the right panel runs the full height and starts with the band.
    h0=t.index('<header '); h1=t.index('</header>',h0)+len('</header>')
    h=t[h0:h1]
    p0=h.index('<span style="flex: 1"></span>')
    h=h[:p0]+'<span style="flex: 1"></span>\n'+L_HIDE+'</header>'
    t=t[:h0]+t[h1:]
    sec='<section aria-label="Agent" style="position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column">'
    t=gsub(t,sec,sec+'\n'+h)
    t=gsub(t,'<aside aria-label="Workspace panels" style="width: 400px;','<aside aria-label="Workspace panels" style="width: 360px;')
    a0='<div style="flex: 1; min-height: 0; display: flex; flex-direction: column">\n<div role="tablist" style="height: 44px;'
    t=gsub(t,a0,lead_band(len(rows))+a0)
    t=gsub(t,'<sc-if value="{{ rt.files }}"',lead_list(rows)+'<sc-if value="{{ rt.files }}"')
    t=gsub(t,"var rtabs = [['files', 'All files', ''],","var rtabs = [['prs', 'PRs', '%d'], ['files', 'All files', ''],"%len(rows))
    t=gsub(t,"rt: { files: s.right === 'files',","rt: { prs: s.right === 'prs', files: s.right === 'files',")
    return t
def g_workspace(tabs, tab, chats, state=None, post='', extra='', update=False):
    t=gsub(ws.replace('%%SCENARIO%%','lead'), 'width: 1440px; height: 900px; box-sizing: border-box; display: flex; overflow: hidden;', 'position: relative; width: 1440px; height: 900px; box-sizing: border-box; display: flex; overflow: hidden;')
    # The canvas row never shrinks its tabs, but the app does (workspace.css: .ws-tab has min-width 0 and an ellipsis).
    t=gsub(t,'height: 40px; max-width: 220px; padding: 0 12px; border: 0; border-bottom: 2px solid {{ t.line }};','height: 40px; min-width: 0; max-width: 220px; padding: 0 12px; border: 0; border-bottom: 2px solid {{ t.line }};')
    t=gsub(t,'<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.5 4a1.5','<svg style="flex-shrink: 0" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.5 4a1.5')
    t=gsub(t,'style="align-self: center; margin-left: -8px; width: 22px; height: 22px;','style="flex-shrink: 0; align-self: center; margin-left: -8px; width: 22px; height: 22px;')
    # The + button's menu hangs off the button, as in the app (ChatTabs.tsx), so it follows the tab row whatever the tab titles are.
    m0=t.index('<sc-if value="{{ newMenu }}"'); m1=t.index('</sc-if>',m0)+len('</sc-if>')
    menu=t[m0:m1].replace('left: {{ newMenuLeft }}; top: 38px;','left: 0; top: calc(100% + 4px);')
    t=t[:m0]+t[m1:]
    b0=t.index('<button type="button" onClick="{{ toggleNewMenu }}"'); b1=t.index('</button>',b0)+len('</button>')
    btn=t[b0:b1].replace('margin-left: 4px; ','')
    t=t[:b0]+'<span style="position: relative; flex-shrink: 0; align-self: center; margin-left: 4px; display: flex">'+btn+menu+'</span>'+t[b1:]
    # KERNEL-335: a tab joins the chat you are in, so the copy says tab.
    t=gsub(t,'<span style="flex: 1">New chat</span><span style="font-size: 12px; color: #8a8f98">⌘T</span>','<span style="flex: 1">New tab</span><span style="font-size: 12px; color: #8a8f98">⌘T</span>')
    t=gsub(t,'New chat with {{ ag.name }}','New tab with {{ ag.name }}')
    t=gsub(t,"label: 'Fork into new chat'","label: 'Fork into new tab'")
    # The new tab state is KERNEL-274's NewChat with the word "tab": its title, subtitle and three suggestions. The centered composer is not built.
    t=gsub(t,'<p style="margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -0.3px">New tab with','<p style="margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.2px">New tab with')
    t=gsub(t,'<p style="margin: 0; color: #8a8f98">Same worktree and branch, fresh context.</p>','<p style="margin: 0; font-size: 13px; color: #8a8f98">Same worktree and branch, fresh context.</p>')
    t=gsub(t,'gap: 8px; max-width: 520px; margin-top: 4px','gap: 8px; max-width: 680px; margin-top: 4px')
    s0=t.index('<sc-for list="{{ suggestions }}"'); s1=t.index('</sc-for>',s0)+len('</sc-for>')
    t=t[:s0]+G_SUGGEST+t[s1:]
    if update:
        t=gsub(t,"isUser: m.kind === 'user',","isUpdate: m.kind === 'update', isUser: m.kind === 'user',")
        t=gsub(t,'<sc-if value="{{ m.isMeta }}"',G_UPDATE+'<sc-if value="{{ m.isMeta }}"')
    if extra: t=gsub(t,'</div>\n</x-dc>',extra+'</div>\n</x-dc>')
    S=dict(agent='rowan', model='opus', effort='high', plan=False, wsName='lead', badge=LEAD_BADGE, filesKey='rowan', tabs=tabs, tab=tab, chats=chats, right='prs')
    S.update(state or {})
    t=lead_workspace(t)
    return g_patch(t, '''
var __S = %s;
var __seed = Component.prototype.seed;
Component.prototype.seed = function (sc) { var s = __seed.call(this, sc); Object.assign(s, __S); return s; };
var __rv = Component.prototype.renderVals;
Component.prototype.renderVals = function () { var v = __rv.call(this); %s return v; };
'''%(json.dumps(S), post))
def g_ws_page(name, rows, **kw):
    emit(name, g_workspace(**kw), None, rows_html=rows[0])
A3=['a1','a2','a3']
a_rows=g_rows(on='a', glyph={'b':'spin'})
def a_tabs(extra=()): return [g_tab(i) for i in A3]+list(extra)
# 1. ⌘N starts a chat: one new row with one tab, Rowan already working.
r=g_rows(chats=('a','b','c','d','e'), glyph={'b':'spin','e':'spin'}, on='e')
g_ws_page('GroupedNewChat', r, tabs=[g_tab('n2')], tab='n2', chats={'n2':G_NEW}, state={'plan':True,'running':True,'secs':9}, post=G_NO_CHANGES)
# 2. The tab row shows only this chat's tabs.
g_ws_page('GroupedTabs', a_rows, tabs=a_tabs(), tab='a1', chats={'a1':G_PLAN,'a2':G_SHARED,'a3':[]}, post=G_NO_CHANGES)
# 3. Another chat swaps the tabs. The open file is the room's, not a chat's, so it stays at the end of the row.
r=g_rows(on='b', glyph={'b':'spin'})
g_ws_page('GroupedSwitchChat', r, tabs=[g_tab('b1'),g_tab('b2'),G_FILE], tab='b1', chats={'b1':G_TABLE,'b2':[]}, state={'running':True,'secs':38,'right':'files'}, post=G_NO_CHANGES+" v.tree.forEach(function (f) { f.st = ''; f.color = '#d0d6e0'; });")
# 4. + adds a tab to this chat.
g_ws_page('GroupedNewTabMenu', a_rows, tabs=a_tabs(), tab='a1', chats={'a1':G_PLAN}, state={'newMenu':True}, post=G_NO_CHANGES)
# 5. A second tab sees the chat's workspaces and plan.
g_ws_page('GroupedSharedWork', a_rows, tabs=a_tabs(), tab='a2', chats={'a2':G_SHARED}, post=G_NO_CHANGES)
# 6, 7. The context-full banner adds a tab to the same chat.
def g_banner(sub): return {'kind':'context','title':'Context is almost full','sub':'Compacting keeps a summary and frees space. '+sub,'actions':[{'id':'newchat','label':'New tab'},{'id':'compact','label':'Compact now','primary':True}]}
g_ws_page('GroupedContextFull', a_rows, tabs=a_tabs(), tab='a1', chats={'a1':G_PLAN}, state={'banner':g_banner('A new tab starts clean in this chat.'),'ctx':92}, post=G_NO_CHANGES)
g_ws_page('GroupedContextFullAfter', a_rows, tabs=a_tabs([g_tab('n3',empty=True)]), tab='n3', chats={'n3':[]}, post=G_NO_CHANGES)
# 8. The tab that handed off was closed, so the update lands in another tab of the chat.
g_ws_page('GroupedUpdateRouted', a_rows, tabs=[g_tab('a2'),g_tab('a3')], tab='a2', update=True, post=G_NO_CHANGES,
    chats={'a2':[U("How is Kai's PR going?"),{'kind':'ai','text':"Kai's PR is open as #43 on invoice-pdf-button. Checks are still running."},{'kind':'update'}]})
# 9. A chat row shows its strongest tab status, and its hover card names the tab that needs you.
r=g_rows(glyph={'b':'spin','c':'ask'}, on='a', hover='c')
hover='''<div role="tooltip" style="position: absolute; z-index: 60; left: 243px; top: %dpx; width: 300px; box-sizing: border-box; display: flex; flex-direction: column; gap: 4px; padding: 11px 14px 10px; border-radius: 10px; border: 1px solid #2a2b30; background: #18191b">
<div style="display: flex; align-items: center; gap: 10px; font-size: 12px; color: #8a8f98"><span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">Client A · Chat with Rowan</span><span style="flex-shrink: 0; display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px; border-radius: 999px; border: 1px solid rgba(242, 197, 92, 0.3); background: #40330f; color: #f2c55c; font-size: 11.5px; font-weight: 500">%s Needs you</span></div>
<div style="font-size: 13px; font-weight: 500; color: #f7f8f8">Client portal login</div>
<div style="font-size: 12px; color: #b7bcc4">Fix the login redirect asks whether to keep Google sign in.</div>
<div style="display: flex; align-items: center; gap: 6px; margin-top: 4px; font-size: 11.5px; color: #8a8f98"><span style="flex: 1">2 tabs · 1 needs you</span><span>4m</span></div>
</div>'''%(g_top(r[1],'c')-6, re.sub(r'width="\d+" height="\d+"','width="12" height="12"',G_ICON['ask'](False),count=1).replace('stroke="#f7f8f8"','stroke="currentColor"'))
g_ws_page('GroupedRowStatus', r, tabs=a_tabs(), tab='a1', chats={'a1':G_PLAN}, extra=hover, post=G_NO_CHANGES)
# 10, 11. Closing the last tab closes the chat. Its workspaces stay as unowned rows.
r=g_rows(on='b', glyph={'b':'spin'})
t=rd('Confirm.dc.html').replace('%%KIND%%','archive')
t=g_patch(t,'''
var __rv = Component.prototype.renderVals;
Component.prototype.renderVals = function () { var v = __rv.call(this); v.under = %s; v.title = 'Close this chat?'; v.body = %s; v.facts = %s; v.hasFacts = true; v.hasOption = false; v.hasAlt = false; v.confirmLabel = 'Close chat'; return v; };
'''%(json.dumps('Invoice table and empty states'), json.dumps('Rowan is still working in this chat. Closing its last tab stops that turn and closes the chat. The 2 workspaces it started stay in the sidebar.'), json.dumps(['Invoice table and empty states','1 tab · Rowan is working'])))
emit('GroupedCloseLastTab', t, None, rows_html=r[0])
r=g_rows(chats=('a','c','d'), unowned=('table','schema','org'), on='a')
g_ws_page('GroupedCloseLastTabAfter', r, tabs=a_tabs(), tab='a1', chats={'a1':G_PLAN}, post=G_NO_CHANGES)
# 12. Ask Rowan opens its answers as tabs of the chat you are in. The sidebar doesn't change.
g_ws_page('GroupedAskRowan', a_rows, tabs=a_tabs([g_tab('q1'),g_tab('q2')]), tab='q2', chats={'q1':G_ASK1,'q2':G_ASK2}, post=G_NO_CHANGES)
# 13. The palette lists the room's chats and says New tab for ⌘T.
def p_it(glyph,label,keys=(),hint=''): return {'glyph':glyph,'label':label,'href':'Workspace.dc.html','keys':list(keys),'hint':hint,'hasHint':bool(hint)}
GP=[('Suggested',[p_it('+','New chat in Client A',['⌘','N']),p_it('+','New tab',['⌘','T']),p_it('>','Big terminal tab',['⌘','⇧','T'])]),
   ('Chats in Client A',[p_it('◇','Export invoices as PDF',hint='3 tabs'),p_it('◇','Invoice table and empty states',hint='2 tabs'),p_it('◇','Client portal login',hint='2 tabs'),p_it('◇','Seed realistic demo data',hint='1 tab')]),
   ('Go to',[p_it('◇','Inbox',['G','I']),p_it('◇','History')]),
   ('Rooms',[p_it('A','Client A'),p_it('B','Client B')])]
pg=[{'title':n,'items':[dict(i,bg='#1f2024' if (n=='Suggested' and k==0) else 'transparent') for k,i in enumerate(its)]} for n,its in GP]
t=rd('CommandPalette.dc.html').replace('%%SHARED%%','off')
t=gsub(t,'<h1 style="margin: 0; font-size: 13px; font-weight: 500">invoice-table</h1>','<h1 style="margin: 0; font-size: 13px; font-weight: 500">lead</h1><span style="font-family: \'Geist Mono\', ui-monospace, monospace; font-size: 12px; color: #8a8f98">%s</span>'%LEAD_BADGE)
# KERNEL-356: behind the scrim the page is the Lead's workspace, so its right panel opens on the PRs tab under the ready band.
t=gsub(t,'<div aria-hidden="true" style="flex: 1"></div>','<div aria-hidden="true" style="flex: 1; min-height: 0; display: flex"><div style="flex: 1"></div><div style="width: 360px; flex-shrink: 0; display: flex; flex-direction: column; border-left: 1px solid #1a1b1e">'+lead_band(len(L_PRS))+'<div style="height: 44px; display: flex; align-items: center; gap: 4px; padding: 0 10px; font-size: 13px; font-weight: 500; color: #8a8f98"><span style="display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 7px; background: #1c1d21; color: #f7f8f8">PRs<span style="font-family: \'Geist Mono\', ui-monospace, monospace; font-size: 11.5px">'+str(len(L_PRS))+'</span></span><span style="padding: 0 10px">All files</span><span style="padding: 0 10px">Changes</span><span style="padding: 0 10px">Checks</span></div></div></div>')
t=g_patch(t,'''
var __rv = Component.prototype.renderVals;
Component.prototype.renderVals = function () { var v = __rv.call(this); v.groups = %s; v.empty = false; return v; };
'''%json.dumps(pg))
emit('GroupedPalette', t, 'search', rows_html=a_rows[0])
# KERNEL-356: WorkspaceLead is the Lead's workspace like the Grouped set, with its plan file under Changes.
# Its plan still waits for approval and Kai has no workspace yet, so only org-invites (#41) is ready.
t=lead_workspace(ws.replace('%%SCENARIO%%','lead'), L_PRS[1:])
t=g_patch(t,'''
var __seed = Component.prototype.seed;
Component.prototype.seed = function (sc) { var s = __seed.call(this, sc); Object.assign(s, %s); return s; };
'''%json.dumps({'wsName':'lead','badge':LEAD_BADGE,'right':'prs'}))
emit('WorkspaceLead', t, 'lead')
# KERNEL-414: Rowan asks a question with long options, so the card is drawn in the Lead's chat.
t=lead_workspace(ws.replace('%%SCENARIO%%','questionlong'), L_PRS[1:])
t=g_patch(t,'''
var __seed = Component.prototype.seed;
Component.prototype.seed = function (sc) { var s = __seed.call(this, sc); Object.assign(s, %s); return s; };
'''%json.dumps({'wsName':'lead','badge':LEAD_BADGE,'right':'prs'}))
emit('WorkspaceQuestionLong', t, 'lead')
# KERNEL-440 (D13): the team and agent surfaces D14, D15 and D16 build. capabilities.py draws them.
import sys
sys.path.insert(0,HERE)
import capabilities
capabilities.build(emit=emit, rd=rd, ws=ws, gsub=gsub, g_patch=g_patch)
# KERNEL-435: permission modes. The composer's mode label and the menus that change it are drawn on boards, like the redesign's Composer.
# Every composer on these boards is the KERNEL-322 composer with the label after the model picker.
for n in ['ComposerModes','ComposerModeMenu']: emit(n, rd(n+'.dc.html'), None)
print(len(out))
if P==SANDBOX: open('/home/claude/built.txt','w').write('\n'.join(out))
p=P+'InboxEmpty.dc.html'; t=open(p).read()
t=t.replace('<span style="flex: 1">Inbox</span><span style="font-size: 12px; color: #8a8f98">3</span>','<span style="flex: 1">Inbox</span>')
open(p,'w').write(t)
