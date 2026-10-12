"""KERNEL-440 (D13): the team and agent surfaces that D14, D15 and D16 build.

Warnings for servers an agent can't reach and for agent files Kernel can't read, the Personal tag, the allowances Kernel adds on
top of a file, the tools gate's approval card, the servers row on the hire card, the roster picker and the rule conflicts in room
setup, and the "for me or for the team" choice on hire, edit and retire. build.py calls build() once, after the Workspace
template is loaded. Every page is plain markup in the canvas's own styles, so a value here is the value to build.
"""
import json

MONO = "'Geist Mono', ui-monospace, monospace"
FONT = "font-family: 'Inter', -apple-system, 'SF Pro Text', system-ui, sans-serif; font-feature-settings: 'cv01', 'ss03'; font-size: 13px; line-height: 1.45; -webkit-font-smoothing: antialiased"
WINDOW = 'box-sizing: border-box; overflow: hidden; border-radius: 12px; border: 1px solid #26272b; background: #08090a; color: #f7f8f8; ' + FONT
LINK = 'padding: 0; border: 0; background: none; color: #d0d6e0; font-family: inherit; font-size: 12px; text-decoration: underline; text-underline-offset: 2px; cursor: pointer'


def ico(path, size=14, stroke='currentColor', sw='1.4', style=''):
    return ('<svg width="%d" height="%d" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="%s" stroke-width="%s" '
            'stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0; %s">%s</svg>') % (size, size, stroke, sw, style, path)


I_WARN = '<path d="M8 2.5 14 13H2ZM8 6.5v3M8 11.2v.1"></path>'
I_ERR = '<circle cx="8" cy="8" r="5.6"></circle><path d="m6 6 4 4M10 6l-4 4"></path>'
I_PLUS = '<circle cx="8" cy="8" r="5.6"></circle><path d="M8 5.6v4.8M5.6 8h4.8"></path>'
I_SEARCH = '<circle cx="7" cy="7" r="4.3"></circle><path d="m10.3 10.3 3.2 3.2"></path>'
I_CHECK = '<path d="m3.5 8.5 3 3 6-7"></path>'
I_ASK = '<path d="M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0ZM6.3 6.4a1.75 1.75 0 1 1 2.5 1.6c-.5.2-.8.6-.8 1.1v.3M8 11.1v.1"></path>'
I_CLOSE = '<path d="m4 4 8 8M12 4l-8 8"></path>'


def page(title, body):
    return ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Kernel · ' + title + '</title>\n'
            '<script src="./support.js"></script>\n</head>\n<body>\n<x-dc>\n<!--HELMET-->\n' + body + '\n</x-dc>\n'
            '<script type="text/x-dc" data-dc-script data-props=\'{"$preview":{"width":1440,"height":900}}\'>\n'
            'class Component extends DCLogic {\n  constructor(props) {\n    super(props);\n    this.state = {};\n  }\n\n'
            '  renderVals() {\n    return {};\n  }\n}\n</script>\n</body>\n</html>\n')


def with_sidebar(inner, extra=''):
    """The window with Kernel's sidebar and footer, the way Team and the agent profile draw it. `extra` sits over the window (scrim, modal)."""
    return ('<div style="position: relative; width: 1440px; height: 900px; display: flex; ' + WINDOW + '">\n<!--SIDEBAR-->\n'
            '<div style="flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 8px 8px 0 0; box-sizing: border-box">\n'
            '<div style="flex: 1; min-height: 0; display: flex; flex-direction: column; background: #0f1011; border: 1px solid #1d1e22; border-radius: 10px; overflow: hidden">\n'
            + inner + '\n</div>\n<!--FOOTER-->\n</div>\n' + extra + '</div>')


# ---- shared pieces -----------------------------------------------------------------------------------------------------

def pill(text, color='#d0d6e0'):
    return ('<span style="height: 18px; padding: 0 6px; border-radius: 999px; border: 1px solid #2a2b30; font-size: 11px; '
            'line-height: 16px; color: %s">%s</span>') % (color, text)


def radio_row(label, desc, on, selected_wrap=''):
    """One choice of a radio group: a ring, a label and what it does. The question card's rows, with a ring instead of a number."""
    border, ring, dot = ('#3a3c42', '#f7f8f8', '#f7f8f8') if on else ('#26272b', '#4a4c52', 'transparent')
    return ('<button type="button" role="radio" aria-checked="%s" style="display: flex; align-items: flex-start; gap: 10px; width: 100%%; '
            'box-sizing: border-box; padding: 10px 12px; border: 1px solid %s; border-radius: 8px; background: transparent; color: #f7f8f8; '
            'font-family: inherit; font-size: 13px; text-align: left; cursor: pointer"><span aria-hidden="true" style="width: 14px; height: 14px; '
            'flex-shrink: 0; margin-top: 2px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; '
            'border-radius: 50%%; border: 1.5px solid %s"><span style="width: 6px; height: 6px; border-radius: 50%%; background: %s"></span></span>'
            '<span style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px"><span>%s</span>'
            '<span style="font-size: 12.5px; line-height: 1.5; color: #8a8f98">%s</span></span></button>') % ('true' if on else 'false', border, ring, dot, label, desc)


def radio_group(label, rows):
    return '<div role="radiogroup" aria-label="%s" style="display: flex; flex-direction: column; gap: 6px">%s</div>' % (label, ''.join(rows))


def checkbox(on, size=16):
    border, bg = ('#f7f8f8', '#f7f8f8') if on else ('#4a4c52', 'transparent')
    mark = ico(I_CHECK, 11, '#08090a', '2') if on else ''
    return ('<span aria-hidden="true" style="width: %dpx; height: %dpx; flex-shrink: 0; box-sizing: border-box; display: inline-flex; '
            'align-items: center; justify-content: center; border-radius: 4px; border: 1px solid %s; background: %s">%s</span>') % (size, size, border, bg, mark)


def server_pills(servers):
    """The servers an agent can reach. A server that works shows its name. One that doesn't shows a warning and what is wrong."""
    out = []
    for name, state in servers:
        if state:
            out.append('<span style="display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px; border-radius: 999px; border: 1px solid #2a2b30; '
                       'font-size: 12.5px; color: #d0d6e0">' + ico(I_WARN, 12, '#f2c55c') + name + '<span style="color: #8a8f98">' + state + '</span></span>')
        else:
            out.append('<span style="display: inline-flex; align-items: center; height: 24px; padding: 0 9px; border-radius: 999px; border: 1px solid #2a2b30; '
                       'font-size: 12.5px; color: #d0d6e0">' + name + '</span>')
    return ''.join(out)


# Copy for what a scope means in each flow. "Just for me" keeps everything on this Mac. "For the team" goes through the code host.
SCOPE = {
    'hire': ('Where should Lumi join?',
             'Saves lumi.md in <span style="font-family: %s; font-size: 12px; white-space: nowrap">~/.claude/agents</span> on this Mac. Only you see Lumi, in every room.' % MONO,
             'Kernel opens a pull request that adds <span style="font-family: %s; font-size: 12px; white-space: nowrap">.claude/agents/lumi.md</span>. Lumi joins everyone once it merges.' % MONO),
    'edit': ('Who gets this change?',
             'Kernel keeps the change on this Mac. The repo’s <span style="font-family: %s; font-size: 12px; white-space: nowrap">kai.md</span> stays as it is.' % MONO,
             'Kernel opens a pull request that changes <span style="font-family: %s; font-size: 12px; white-space: nowrap">.claude/agents/kai.md</span>. Everyone gets it once it merges.' % MONO),
    'retire': ('Who loses Kai?',
               'Kai leaves your team on this Mac. The repo’s file stays where it is.',
               'Kernel opens a pull request that moves <span style="font-family: %s; font-size: 12px; white-space: nowrap">kai.md</span> to <span style="font-family: %s; font-size: 12px; white-space: nowrap">.claude/retired-agents</span>. Everyone loses Kai once it merges.' % (MONO, MONO)),
}


def scope_group(kind, team):
    label, me, them = SCOPE[kind]
    return ('<div style="display: flex; flex-direction: column; gap: 8px"><span style="font-size: 12px; font-weight: 500; color: #8a8f98">' + label + '</span>'
            + radio_group(label, [radio_row('Just for me', me, not team), radio_row('For the team', them, team)]) + '</div>')


# ---- Team --------------------------------------------------------------------------------------------------------------

def note(kind, text, action=''):
    """A line under an agent on Team. 'warn' is a server the agent can't reach, 'allow' is something Kernel adds on top of its file."""
    icon = ico(I_WARN, 12, '#f2c55c') if kind == 'warn' else ico(I_PLUS, 12, '#8a8f98')
    color = '#d0d6e0' if kind == 'warn' else '#8a8f98'
    act = '<button type="button" style="%s">%s</button>' % (LINK, action) if action else ''
    return '<span style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: %s; white-space: nowrap">%s<span>%s</span>%s</span>' % (color, icon, text, act)


def team_row(name, role, desc, model, status, ws, file, shirt, tags=(), notes=()):
    color = {'Working': '#d0d6e0', 'Needs you': '#f7f8f8', 'Idle': '#8a8f98'}[status]
    height = 64 + 16 * len(notes)
    return ('<a href="AgentProfile.dc.html" style="display: grid; grid-template-columns: minmax(0, 2.4fr) 120px 140px minmax(0, 1.4fr) minmax(0, 1.4fr); gap: 16px; '
            'align-items: center; height: %dpx; padding: 0 12px; border-top: 1px solid #17181a; color: #f7f8f8; text-decoration: none">'
            '<span style="display: flex; align-items: center; gap: 12px; min-width: 0">'
            '<span aria-hidden="true" style="width: 32px; height: 32px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%%; '
            'background: %s; font-size: 13px; font-weight: 600">%s</span>'
            '<span style="display: flex; flex-direction: column; min-width: 0"><span style="display: flex; align-items: center; gap: 8px"><span style="font-weight: 500">%s</span>'
            '<span style="font-size: 12px; color: #8a8f98">%s</span>%s</span>'
            '<span style="font-size: 12px; color: #8a8f98; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">%s</span>%s</span></span>'
            '<span style="font-size: 12.5px; color: #d0d6e0">%s</span>'
            '<span style="display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: %s">%s</span>'
            '<span style="font-family: %s; font-size: 12px; color: #d0d6e0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">%s</span>'
            '<span style="font-family: %s; font-size: 12px; color: #8a8f98; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">%s</span></a>'
            ) % (height, shirt, name[0], name, role, ''.join(pill(t) for t in tags), desc, ''.join(notes), model, color, status, MONO, ws, MONO, file)


def team_page(title, intro, rows, counts, after='', footnote=''):
    filters = ''.join(
        '<button type="button" aria-pressed="%s" style="height: 24px; padding: 0 10px; border: 0; border-radius: 6px; background: %s; color: %s; font-family: inherit; '
        'font-size: 12px; font-weight: 500; cursor: pointer">%s<span style="margin-left: 6px; color: #8a8f98">%d</span></button>'
        % ('true' if i == 0 else 'false', '#1c1d21' if i == 0 else 'transparent', '#f7f8f8' if i == 0 else '#8a8f98', label, n)
        for i, (label, n) in enumerate(counts))
    head = ('<header style="height: 44px; flex-shrink: 0; box-sizing: border-box; display: flex; align-items: center; gap: 8px; padding: 0 12px 0 16px">'
            '<span aria-hidden="true" style="width: 18px; height: 18px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; border-radius: 5px; '
            'border: 1px solid #2a2b30; background: #1c1d21; font-size: 10px; font-weight: 600">A</span>'
            '<a href="Rooms.dc.html" style="color: #d0d6e0; text-decoration: none">Client A</a>' + ico('<path d="M6 3.5 10.5 8 6 12.5"></path>', 12, '#62666d', '1.6')
            + '<h1 style="margin: 0; font-size: 13px; font-weight: 500">Team</h1><span style="flex: 1"></span>'
            '<a href="NewAgent.dc.html" style="display: inline-flex; align-items: center; gap: 6px; height: 28px; box-sizing: border-box; padding: 0 12px 0 10px; border-radius: 7px; '
            'background: #f7f8f8; color: #08090a; text-decoration: none; font-weight: 500">' + ico('<path d="M8 3.5v9M3.5 8h9"></path>', 12, 'currentColor', '1.6') + 'New agent</a></header>')
    bar = ('<div style="height: 44px; flex-shrink: 0; box-sizing: border-box; display: flex; align-items: center; gap: 6px; padding: 0 12px; border-bottom: 1px solid #1a1b1e">'
           '<div role="group" aria-label="Filter by status" style="display: flex; gap: 2px; padding: 2px; border-radius: 8px; border: 1px solid #1f2024">' + filters + '</div></div>')
    grid = ('<div style="display: grid; grid-template-columns: minmax(0, 2.4fr) 120px 140px minmax(0, 1.4fr) minmax(0, 1.4fr); gap: 16px; height: 36px; align-items: center; '
            'padding: 0 12px; font-size: 12px; color: #8a8f98"><span>Agent</span><span>Model</span><span>Status</span><span>Workspace</span><span>File</span></div>')
    body = ('<div style="flex: 1; min-height: 0; overflow: hidden; padding: 20px 28px"><p style="margin: 0 0 16px; color: #8a8f98">' + intro + '</p>' + grid
            + ''.join(rows) + footnote + after + '</div>')
    return page(title, with_sidebar(head + bar + body))


def path(p):
    return '<span style="font-family: %s; color: #d0d6e0">%s</span>' % (MONO, p)


INTRO_REPO = 'Agents come from ' + path('.claude/agents') + ' in this repo. Add a file, or ask Rowan to write one, and the agent joins the team.'
INTRO_BOTH = ('Agents come from ' + path('.claude/agents') + ' in this repo and ' + path('~/.claude/agents')
              + ' on this Mac. Add a file, or ask Rowan to write one, and the agent joins the team.')

NO_SERVER = 'There’s no %s server in this room.'
FAILED = '%s didn’t connect after 3 tries.'
SIGNED_OUT = '%s isn’t signed in.'
SWITCHED_OFF = '%s is switched off in this room.'
ALLOWED = '%s allowed in this room by you'


def cant_read(file, error):
    return ('<section aria-label="Files Kernel can’t read" style="margin-top: 28px"><h2 style="margin: 0 0 8px; padding: 0 12px; font-size: 12px; font-weight: 500; color: #8a8f98">Can’t read</h2>'
            '<div style="display: flex; align-items: flex-start; gap: 12px; padding: 12px; border-top: 1px solid #17181a">' + ico(I_ERR, 14, '#eb5757', '1.6', 'margin-top: 2px')
            + '<div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px"><span style="font-family: ' + MONO + '; font-size: 12.5px">' + file + '</span>'
            '<span style="font-size: 12.5px; color: #d0d6e0">Kernel can’t read this file, so the agent isn’t on the team.</span>'
            '<span style="font-family: ' + MONO + '; font-size: 12px; color: #8a8f98">' + error + '</span></div>'
            '<button type="button" style="' + LINK + '; margin-top: 1px">Open file</button></div></section>')


def team_warnings():
    rows = [
        team_row('Rowan', 'Lead', 'Plans, splits tasks, hands them out. Never edits code.', 'Opus 5.5', 'Idle', 'main checkout', '.claude/agents/rowan.md', '#3f4652'),
        team_row('Kai', 'Frontend', 'UI work. Follows DESIGN.md.', 'Sonnet 5.5', 'Working', 'invoice-pdf-button', '.claude/agents/kai.md', '#5b6b5e',
                 notes=[note('warn', SIGNED_OUT % 'Linear', 'Sign in'), note('warn', NO_SERVER % 'Figma', 'Add server')]),
        team_row('Noor', 'Backend', 'Schema, API and migrations.', 'Sonnet 5.5', 'Needs you', 'invoice-pdf-renderer', '.claude/agents/noor.md', '#6b5d73',
                 notes=[note('warn', FAILED % 'Neon', 'Try again')]),
        team_row('Ivy', 'QA', 'Runs tests and attaches the output.', 'Sonnet 5.5', 'Working', 'invoice-pdf-tests', '.claude/agents/ivy.md', '#7a6a55',
                 notes=[note('warn', SWITCHED_OFF % 'Playwright', 'Turn on')]),
        team_row('Theo', 'Reviewer', 'Types at boundaries, security, tenant isolation.', 'Opus 5.5', 'Idle', 'invoice-pdf-review', '.claude/agents/theo.md', '#4b5560'),
        team_row('Lumi', 'Designer', 'Checks every screen against DESIGN.md.', 'Sonnet 5.5', 'Idle', 'none', '.claude/agents/lumi.md', '#5f6f7a'),
    ]
    after = cant_read('.claude/agents/triage.md', 'Nested mappings are not allowed in compact mappings at line 3, column 21')
    return team_page('Team · servers and unreadable files', INTRO_REPO, rows, [('All', 6), ('Working', 2), ('Needs you', 1), ('Idle', 3)], after)


def team_personal():
    rows = [
        team_row('Rowan', 'Lead', 'Plans, splits tasks, hands them out. Never edits code.', 'Opus 5.5', 'Idle', 'main checkout', '.claude/agents/rowan.md', '#3f4652'),
        team_row('Kai', 'Frontend', 'UI work. Follows DESIGN.md.', 'Sonnet 5.5', 'Working', 'invoice-pdf-button', '.claude/agents/kai.md', '#5b6b5e',
                 notes=[note('allow', ALLOWED % 'Linear', 'Remove')]),
        team_row('Noor', 'Backend', 'Schema, API and migrations.', 'Sonnet 5.5', 'Needs you', 'invoice-pdf-renderer', '.claude/agents/noor.md', '#6b5d73',
                 notes=[note('allow', ALLOWED % 'Neon', 'Remove'), note('allow', ALLOWED % 'Vercel', 'Remove')]),
        team_row('Theo', 'Reviewer', 'Types at boundaries, security, tenant isolation.', 'Opus 5.5', 'Idle', 'invoice-pdf-review', '.claude/agents/theo.md', '#4b5560'),
        team_row('Scout', 'Researcher', 'Finds prior art and reads the docs before a task starts.', 'Sonnet 5.5', 'Working', 'invoice-pdf-renderer', '~/.claude/agents/scout.md', '#6a6256', tags=['Personal']),
        team_row('Mira', 'Writer', 'Drafts release notes and docs from merged PRs.', 'Sonnet 5.5', 'Idle', 'none', '~/.claude/agents/mira.md', '#5f6f7a', tags=['Personal'],
                 notes=[note('allow', ALLOWED % 'Notion', 'Remove')]),
    ]
    foot = ('<p style="margin: 16px 0 0; padding: 0 12px; font-size: 12px; color: #8a8f98">Allowed in this room means Kernel lets the agent use a server its file doesn’t list. '
            'The files stay as they are.</p>')
    return team_page('Team · Personal agents and allowances', INTRO_BOTH, rows, [('All', 6), ('Working', 2), ('Needs you', 1), ('Idle', 3)], '', foot)



# ---- Agent profile -----------------------------------------------------------------------------------------------------

def server_row(name, source, state, action='', allowed=False):
    """A row of the profile's Servers list: the server, where it comes from, how it is doing and the one step that fixes it."""
    status = ('<span style="display: inline-flex; align-items: center; gap: 6px; color: #f7f8f8">' + ico(I_WARN, 12, '#f2c55c') + state + '</span>') if state != 'Connected' \
        else '<span style="color: #8a8f98">Connected</span>'
    src = ('<span style="display: inline-flex; align-items: center; gap: 6px; color: #d0d6e0">' + ico(I_PLUS, 12, '#8a8f98') + source + '</span>') if allowed \
        else '<span style="color: #8a8f98">' + source + '</span>'
    act = '<button type="button" style="%s">%s</button>' % (LINK, action) if action else ''
    return ('<div style="display: grid; grid-template-columns: 112px minmax(0, 1fr) 128px 92px; align-items: center; gap: 12px; height: 40px; padding: 0 14px; border-top: 1px solid #1a1b1e; font-size: 12.5px">'
            '<span style="font-weight: 500">%s</span>%s%s<span style="text-align: right">%s</span></div>') % (name, src, status, act)


def servers_section(rows, helper):
    return ('<div style="display: flex; flex-direction: column; gap: 8px"><span style="font-size: 12px; font-weight: 500; color: #8a8f98">Servers</span>'
            '<div style="border-radius: 10px; border: 1px solid #1f2024; overflow: hidden; margin-top: 0">' + ''.join(rows).replace('border-top: 1px solid #1a1b1e', 'border-top: 1px solid #1a1b1e', 1)
            + '</div><span style="font-size: 12px; color: #8a8f98">' + helper + '</span></div>')


def chips(items):
    out = []
    for label, on in items:
        border, bg, color = ('#3a3c42', '#1c1d21', '#f7f8f8') if on else ('#23252a', 'transparent', '#8a8f98')
        out.append('<button type="button" aria-pressed="%s" style="height: 28px; padding: 0 10px; border: 1px solid %s; border-radius: 7px; background: %s; color: %s; font-family: %s; '
                   'font-size: 12px; cursor: pointer">%s</button>' % ('true' if on else 'false', border, bg, color, MONO, label))
    return '<div style="display: flex; flex-wrap: wrap; gap: 6px">' + ''.join(out) + '</div>'


def seg(label, options, on):
    btns = ''.join('<button type="button" role="radio" aria-checked="%s" style="flex: 1; height: 28px; border: 0; border-radius: 6px; background: %s; color: %s; font-family: inherit; '
                   'font-size: 12px; font-weight: 500; cursor: pointer">%s</button>' % ('true' if o == on else 'false', '#24252a' if o == on else 'transparent', '#f7f8f8' if o == on else '#8a8f98', o)
                   for o in options)
    return ('<div style="display: flex; flex-direction: column; gap: 6px"><span style="font-size: 12px; font-weight: 500; color: #8a8f98">' + label + '</span>'
            '<div role="radiogroup" aria-label="' + label + '" style="display: flex; gap: 2px; padding: 2px; border-radius: 8px; border: 1px solid #23252a">' + btns + '</div></div>')


def field(label, name, text, rows, mono=False, hint=''):
    font = "font-family: %s; font-size: 12.5px; line-height: 1.65; color: #e3e5e8; padding: 12px 14px" % MONO if mono else 'font-family: inherit; font-size: 13.5px; line-height: 1.5; color: #f7f8f8; padding: 10px 12px'
    h = '<span style="font-size: 12px; color: #8a8f98">' + hint + '</span>' if hint else ''
    return ('<div style="display: flex; flex-direction: column; gap: 6px"><label for="%s" style="font-size: 12px; font-weight: 500; color: #8a8f98">%s</label>'
            '<textarea id="%s" rows="%d" style="resize: none; box-sizing: border-box; border-radius: 8px; border: 1px solid #23252a; background: #0b0c0d; outline: none; %s">%s</textarea>%s</div>') % (name, label, name, rows, font, text, h)


def section(label, inner):
    return '<div style="display: flex; flex-direction: column; gap: 8px"><span style="font-size: 12px; font-weight: 500; color: #8a8f98">' + label + '</span>' + inner + '</div>'


def profile(name, role, shirt, tags, status, ws, file, rooms, recent, desc, model, tools, servers, skills, prompt, dirty=False, effort='High'):
    initial = name[0]
    save = ('background: #f7f8f8; color: #08090a' if dirty else 'background: #1c1d21; color: #62666d')
    head = ('<header style="height: 44px; flex-shrink: 0; box-sizing: border-box; display: flex; align-items: center; gap: 8px; padding: 0 12px 0 16px; border-bottom: 1px solid #1a1b1e">'
            '<a href="WorkspaceLead.dc.html" style="color: #d0d6e0; text-decoration: none">Client A</a><span style="color: #62666d">/</span>'
            '<a href="Team.dc.html" style="color: #d0d6e0; text-decoration: none">Team</a><span style="color: #62666d">/</span>'
            '<h1 style="margin: 0; font-size: 13px; font-weight: 500">' + name + '</h1><span style="flex: 1"></span>'
            '<a href="ConfirmRetire.dc.html" style="display: inline-flex; align-items: center; height: 28px; padding: 0 12px; border-radius: 7px; color: #d0d6e0; text-decoration: none; font-weight: 500">Retire</a>'
            '<button type="button" style="height: 28px; padding: 0 12px; border: 0; border-radius: 7px; ' + save + '; font-family: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer">Save changes</button></header>')
    dl = ''.join('<dt style="color: #8a8f98">%s</dt><dd style="margin: 0; %s">%s</dd>' % (k, st, v) for k, st, v in [
        ('Status', '', status),
        ('Workspace', 'color: #8a8f98' if ws == 'none' else "font-family: %s; font-size: 12px" % MONO, ws),
        ('File', "font-family: %s; font-size: 12px; color: #b7bcc4" % MONO, file.replace('agents/', 'agents/<wbr>')),
        ('Rooms', 'color: #d0d6e0', rooms)])
    recents = ''.join('<a href="Workspace.dc.html" style="display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 8px; border: 1px solid #1f2024; color: #f7f8f8; text-decoration: none">'
                      '<span>%s</span><span style="font-size: 12px; color: #8a8f98">%s</span></a>' % r for r in recent)
    aside = ('<aside aria-label="' + name + '" style="width: 300px; flex-shrink: 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 18px; padding: 24px; border-right: 1px solid #1a1b1e">'
             '<div style="display: flex; align-items: center; gap: 12px"><span aria-hidden="true" style="width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center; '
             'border-radius: 50%; background: ' + shirt + '; font-size: 18px; font-weight: 600">' + initial + '</span><div style="display: flex; flex-direction: column"><span style="font-size: 16px; font-weight: 600">' + name + '</span>'
             '<span style="display: flex; align-items: center; gap: 8px; color: #8a8f98">' + role + ''.join(pill(t) for t in tags) + '</span></div></div>'
             '<dl style="margin: 0; display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 10px 12px">' + dl + '</dl>'
             '<div style="display: flex; flex-direction: column; gap: 8px"><span style="font-size: 12px; font-weight: 500; color: #8a8f98">Recent work</span>' + recents + '</div></aside>')
    main = ('<div style="flex: 1; min-width: 0; overflow: hidden"><div style="max-width: 720px; display: flex; flex-direction: column; gap: 22px; padding: 24px 32px 40px">'
            + field('Description', 'ap-desc', desc, 2, hint='Rowan reads this to decide what to hand ' + name + '.')
            + '<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px">'
            + seg('Model', ['Sonnet 5.5', 'Opus 5.5', 'Haiku 4.5', 'Fable 5.1'], model) + seg('Effort', ['Low', 'Medium', 'High', 'Extra high'], effort) + '</div>'
            + section('Tools', chips(tools)) + servers + section('Skills', chips(skills))
            + field('Instructions', 'ap-prompt', prompt, 12, mono=True) + '</div></div>')
    return head + '<div style="flex: 1; min-height: 0; display: flex">' + aside + main + '</div>'


TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'WebFetch']


def agent_profile_servers():
    rows = [
        server_row('Notion', 'In its file', 'Connected'),
        server_row('Linear', 'In its file', 'Needs sign-in', 'Sign in'),
        server_row('Slack', 'In its file', 'Missing', 'Add server'),
        server_row('Google Drive', 'In its file', 'Failed', 'Try again'),
        server_row('GitHub', 'In its file', 'Switched off', 'Turn on'),
        server_row('Vercel', 'Allowed in this room by you', 'Connected', 'Remove', allowed=True),
    ]
    servers = servers_section(rows, 'Until these work, Rowan won’t hand Mira tasks that need them.')
    inner = profile('Mira', 'Writer', '#5f6f7a', ['Personal'], 'Idle', 'none', '~/.claude/agents/mira.md', 'All rooms',
                    [('T-16 Release notes for 0.9', 'Merged · PR #44'), ('T-12 Invoice docs', 'Merged · PR #40')],
                    'Drafts release notes and docs from merged PRs, in plain sentences.', 'Sonnet 5.5',
                    [(t, t in ('Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch')) for t in TOOLS], servers,
                    [('/plan', False), ('/feature', False), ('/verify', True), ('/image', False)],
                    'You are Mira, the writer in this room.\n\nRead the merged PRs since the last release and write one plain sentence for each change a user would notice.\n'
                    'Describe what changed for them, not what the code does. No hype.\nNever edit source files. Release notes and docs only.')
    return page('Mira', with_sidebar(inner))


# ---- modals ------------------------------------------------------------------------------------------------------------

def scrim():
    return '<a href="Team.dc.html" aria-label="Cancel" class="scrim" style="position: absolute; inset: 0; z-index: 40; background: rgba(0, 0, 0, 0.55)"></a>\n'


def button(label, primary=False, ghost=False, height=32, size=13):
    if primary:
        style = 'border: 0; background: #f7f8f8; color: #08090a; padding: 0 14px'
    else:
        style = 'border: 0; background: transparent; color: #d0d6e0; padding: 0 12px'
    return '<button type="button" style="height: %dpx; %s; border-radius: 8px; font-family: inherit; font-size: %dpx; font-weight: 500; cursor: pointer">%s</button>' % (height, style, size, label)


def confirm_dialog(title, body, facts, scope, cancel, confirm, top=170, width=480):
    facts_html = ''
    if facts:
        facts_html = ('<div style="display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 8px; background: #111214; font-family: ' + MONO + '; font-size: 12px; color: #b7bcc4">'
                      + ''.join('<span style="white-space: pre-wrap">%s</span>' % f for f in facts) + '</div>')
    return ('<section role="dialog" aria-modal="true" aria-labelledby="cf-title" style="position: absolute; z-index: 50; left: 50%; top: ' + str(top) + 'px; transform: translateX(-50%); width: ' + str(width) + 'px; '
            'box-sizing: border-box; display: flex; flex-direction: column; border-radius: 14px; border: 1px solid #2a2b30; background: #18191b">'
            '<div style="display: flex; flex-direction: column; gap: 12px; padding: 20px 20px 16px"><h2 id="cf-title" style="margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.2px">' + title + '</h2>'
            '<p style="margin: 0; color: #b7bcc4; line-height: 1.55">' + body + '</p>' + facts_html + scope + '</div>'
            '<div style="display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-top: 1px solid #26272b"><span style="flex: 1"></span>' + button(cancel) + button(confirm, primary=True) + '</div></section>\n')


def agent_profile_scope():
    """Saving a change to a repo agent: who gets it. The page behind is Kai's profile with two edits made."""
    tools = [(t, True) for t in TOOLS]
    inner = profile('Kai', 'Frontend', '#5b6b5e', [], 'Working', 'invoice-pdf-button', '.claude/agents/kai.md', 'Client A, Own app',
                    [('T-15b Download PDF button', 'In progress · invoice-pdf-button'), ('T-14 Invoice table', 'Merged · PR #42'), ('T-09 Org settings page', 'Merged · PR #38')],
                    'Frontend engineer. Builds UI from approved plans and follows DESIGN.md.', 'Opus 5.5', tools,
                    servers_section([server_row('GitHub', 'In its file', 'Connected'), server_row('Linear', 'In its file', 'Connected')], 'Rowan can hand Kai tasks that need these.'),
                    [('/plan', False), ('/feature', True), ('/verify', True), ('/image', True)],
                    'You are Kai, the frontend engineer in this room.\n\nWork only inside your worktree. Read DESIGN.md before touching UI.\nEvery screen needs empty, loading and error states.\n'
                    'Run pnpm test and attach the output before you mark a task done.\nNever push to main. Rowan merges after Theo approves.', dirty=True)
    facts = ['<span style="color: #8a8f98">.claude/agents/kai.md</span>',
             '<span style="color: #eb5757">- model: sonnet</span>', '<span style="color: #4cb782">+ model: opus</span>',
             '<span style="color: #eb5757">- tools: Read, Edit, Write, Bash, Grep, Glob</span>', '<span style="color: #4cb782">+ tools: Read, Edit, Write, Bash, Grep, Glob, WebFetch</span>']
    dlg = confirm_dialog('Save changes to Kai', 'Two lines of Kai’s file change.', facts, scope_group('edit', False), 'Cancel', 'Save for me', top=150, width=520)
    return page('Save changes to Kai', with_sidebar(inner, scrim() + dlg))


def confirm_retire_scope():
    inner = profile('Kai', 'Frontend', '#5b6b5e', [], 'Working', 'invoice-pdf-button', '.claude/agents/kai.md', 'Client A, Own app',
                    [('T-15b Download PDF button', 'In progress · invoice-pdf-button'), ('T-14 Invoice table', 'Merged · PR #42'), ('T-09 Org settings page', 'Merged · PR #38')],
                    'Frontend engineer. Builds UI from approved plans and follows DESIGN.md.', 'Sonnet 5.5', [(t, t != 'WebFetch') for t in TOOLS],
                    servers_section([server_row('GitHub', 'In its file', 'Connected'), server_row('Linear', 'In its file', 'Connected')], 'Rowan can hand Kai tasks that need these.'),
                    [('/plan', False), ('/feature', True), ('/verify', True), ('/image', True)],
                    'You are Kai, the frontend engineer in this room.\n\nWork only inside your worktree. Read DESIGN.md before touching UI.\nEvery screen needs empty, loading and error states.\n'
                    'Run pnpm test and attach the output before you mark a task done.\nNever push to main. Rowan merges after Theo approves.')
    facts = ['.claude/agents/kai.md', '1 open workspace goes to Rowan']
    dlg = confirm_dialog('Retire Kai?', 'Kai finishes the current turn, then leaves the team and the workspace picker. You can bring Kai back later.', facts, scope_group('retire', True),
                         'Cancel', 'Open pull request', top=150, width=520)
    return page('Retire an agent', with_sidebar(inner, scrim() + dlg))


FILE_LINES = ['---', 'name: lumi', 'description: A designer who checks every screen against DESIGN.md', 'before review.', 'model: sonnet',
              'tools: Read, Grep, Glob, Bash(pnpm screenshot:*), mcp__figma__*, mcp__linear__*', '---',
              'You are Lumi. Before Theo reviews a PR, open each', 'changed screen, compare it with DESIGN.md, and list drift', 'in spacing, type and color with file and line.']


def new_agent_draft_scope():
    skeleton = ('<header style="height: 44px; flex-shrink: 0; box-sizing: border-box; display: flex; align-items: center; gap: 8px; padding: 0 16px; border-bottom: 1px solid #1a1b1e">'
                '<span style="color: #d0d6e0">Client A</span><span style="color: #62666d">/</span><h1 style="margin: 0; font-size: 13px; font-weight: 500">Team</h1></header>'
                '<div aria-hidden="true" style="padding: 24px 40px; display: flex; flex-direction: column"><div style="height: 64px; border-bottom: 1px solid #17181a; display: flex; align-items: center; gap: 12px">'
                '<span style="width: 32px; height: 32px; border-radius: 50%; background: #3f4652"></span><span>Rowan</span></div><div style="height: 64px; border-bottom: 1px solid #17181a; display: flex; align-items: center; gap: 12px">'
                '<span style="width: 32px; height: 32px; border-radius: 50%; background: #5b6b5e"></span><span>Kai</span></div><div style="height: 64px; border-bottom: 1px solid #17181a; display: flex; align-items: center; gap: 12px">'
                '<span style="width: 32px; height: 32px; border-radius: 50%; background: #6b5d73"></span><span>Noor</span></div></div>')
    lines = ''.join('<span style="white-space: pre-wrap">%s</span>' % l for l in FILE_LINES)
    servers = ('<div style="display: flex; flex-direction: column; gap: 8px"><div style="display: flex; align-items: center; gap: 12px"><span style="width: 56px; flex-shrink: 0; font-size: 12px; font-weight: 500; color: #8a8f98">Servers</span>'
               '<div style="display: flex; flex-wrap: wrap; gap: 6px">' + server_pills([('Figma', ''), ('Linear', 'Needs sign-in')]) + '</div></div>'
               '<span style="font-size: 12.5px; line-height: 1.5; color: #8a8f98">Lumi can’t use Linear until you sign in, so Rowan won’t hand Lumi Linear tasks.</span></div>')
    dlg = ('<section role="dialog" aria-modal="true" aria-labelledby="na-title" style="position: absolute; z-index: 50; left: 50%; top: 56px; transform: translateX(-50%); width: 600px; box-sizing: border-box; '
           'display: flex; flex-direction: column; border-radius: 14px; border: 1px solid #2a2b30; background: #18191b">'
           '<div style="display: flex; align-items: center; height: 52px; padding: 0 10px 0 18px"><h2 id="na-title" style="flex: 1; margin: 0; font-size: 14px; font-weight: 500">Review lumi.md</h2>'
           '<a href="Team.dc.html" aria-label="Close" style="width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border-radius: 7px; color: #8a8f98">' + ico(I_CLOSE, 16, 'currentColor', '1.5') + '</a></div>'
           '<div style="display: flex; flex-direction: column; gap: 14px; padding: 6px 18px 18px">'
           '<div style="display: flex; align-items: center; gap: 10px"><span aria-hidden="true" style="width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background: #3f4652; font-size: 11px; font-weight: 600">R</span>'
           '<span style="color: #d0d6e0"><span style="color: #f7f8f8; font-weight: 500">Rowan</span> drafted the agent file</span></div>'
           '<div style="border-radius: 10px; border: 1px solid #23252a; background: #0a0b0c; overflow: hidden"><div style="display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; border-bottom: 1px solid #1f2024; '
           'font-family: ' + MONO + '; font-size: 12px; color: #d0d6e0">~/.claude/agents/lumi.md<span style="height: 18px; padding: 0 6px; border-radius: 999px; border: 1px solid #2a2b30; font-family: \'Inter\', -apple-system, system-ui, sans-serif; '
           'font-size: 11px; line-height: 16px; color: #8a8f98">new file</span></div><div style="display: flex; flex-direction: column; padding: 10px 12px; font-family: ' + MONO + '; font-size: 12.5px; line-height: 1.7; color: #b7bcc4">' + lines + '</div></div>'
           '<a href="WorkspaceHire.dc.html" style="align-self: flex-start; color: #d0d6e0; font-size: 12.5px">Refine it in a chat with Rowan</a>'
           + servers + scope_group('hire', False) + '</div>'
           '<div style="display: flex; align-items: center; gap: 10px; height: 56px; padding: 0 14px 0 18px; border-top: 1px solid #26272b"><span style="flex: 1"></span>' + button('Back', height=30) + button('Create agent', primary=True, height=30) + '</div></section>\n')
    return page('New agent · Review the file', with_sidebar(skeleton, '<div class="scrim" style="position: absolute; inset: 0; z-index: 40; background: rgba(0, 0, 0, 0.55)"></div>\n' + dlg))



# ---- Workspace cards ---------------------------------------------------------------------------------------------------

def patch_card(t, gsub, servers='', choice='', note=''):
    """Extra pieces for the one card on the page. The page's own markup goes in, behind a flag the seeded card sets."""
    t = gsub(t, 'hasActions: !!m.actions', 'hasActions: !!m.actions, kServers: !!m.kServers, kChoice: !!m.kChoice, kNote: !!m.kNote')
    start = t.index('<sc-if value="{{ m.hasActions }}"')
    end = t.index('\n', start)
    actions = t[start:end]
    before = ('<sc-if value="{{ m.kServers }}" hint-placeholder-val="{{ false }}">' + servers + '</sc-if>\n'
              '<sc-if value="{{ m.kChoice }}" hint-placeholder-val="{{ false }}">' + choice + '</sc-if>\n')
    after = '\n<sc-if value="{{ m.kNote }}" hint-placeholder-val="{{ false }}">' + note + '</sc-if>'
    return t[:start] + before + actions + after + t[end:]


def seed_patch(fields):
    """Overrides what the page's scenario seeds, and teaches the page about Lumi."""
    return ('\nvar __ag = Component.prototype.agents;\nComponent.prototype.agents = function () { var a = __ag.call(this); a.lumi = { name: \'Lumi\', role: \'Designer\', shirt: \'#5f6f7a\' }; return a; };\n'
            'var __seed = Component.prototype.seed;\nComponent.prototype.seed = function (sc) { var s = __seed.call(this, sc); var o = %s; '
            'if (o.lastCard) { Object.assign(s.msgs[s.msgs.length - 1], o.lastCard); delete o.lastCard; } Object.assign(s, o); s.chats = { c1: s.msgs }; return s; };\n') % json.dumps(fields)


def tools_gate(ws, gsub, g_patch):
    note = ('<p style="margin: 0; font-size: 12.5px; line-height: 1.55; color: #8a8f98">Keep blocked tells Lumi to carry on without Linear. Only you can change Lumi\u2019s agent file, so Lumi can\u2019t add Linear itself. '
            'What you allow shows on Team.</p>')
    t = patch_card(ws.replace('%%SCENARIO%%', 'perm'), gsub, note=note)
    msgs = [{'kind': 'user', 'parts': [{'t': 'Check the invoice table and its states against DESIGN.md and the acceptance criteria.'}]},
            {'kind': 'tools', 'text': '9 tool calls, 2 messages'},
            {'kind': 'ai', 'text': 'The table, its empty state and its loading state match DESIGN.md. I need the acceptance criteria from the Linear issue to check the error state.'},
            {'kind': 'card', 'title': 'Lumi wants to use Linear', 'sub': 'Lumi\u2019s agent file doesn\u2019t list Linear. Kernel asks before the call goes ahead.',
             'code': ['mcp__linear__get_issue', 'id: "INV-14"'], 'kNote': True,
             'actions': [{'id': 'keep', 'label': 'Keep blocked'}, {'id': 'always', 'label': 'Allow Linear for Lumi in this room'}, {'id': 'allow', 'label': 'Allow once', 'primary': True}]}]
    return g_patch(t, seed_patch({'agent': 'lumi', 'wsName': 'invoice-table', 'badge': 'feat/t-14-invoice-table', 'filesKey': 'kai',
                                  'tabs': [{'id': 'c1', 'kind': 'chat', 'title': 'Design check'}], 'msgs': msgs}))


def hire_servers(ws, gsub, g_patch):
    servers = ('<div style="display: flex; flex-direction: column; gap: 8px"><div style="display: flex; align-items: center; gap: 12px"><span style="width: 56px; flex-shrink: 0; font-size: 12px; font-weight: 500; color: #8a8f98">Servers</span>'
               '<div style="display: flex; flex-wrap: wrap; gap: 6px">' + server_pills([('Figma', ''), ('Linear', 'Needs sign-in')]) + '</div></div>'
               '<span style="font-size: 12.5px; line-height: 1.5; color: #8a8f98">Lumi can\u2019t use Linear until you sign in, so Rowan won\u2019t hand Lumi Linear tasks.</span></div>')
    t = patch_card(ws.replace('%%SCENARIO%%', 'hire'), gsub, servers=servers, choice=scope_group('hire', True))
    code = ['---', 'name: lumi', 'description: Designer. Checks every screen against DESIGN.md', '  before Theo reviews it. Flags spacing, type and color drift.', 'model: sonnet',
            'tools: Read, Grep, Glob, Bash(pnpm screenshot:*),', '  mcp__figma__*, mcp__linear__*', '---']
    last = {'code': code, 'kServers': True, 'kChoice': True, 'actions': [{'id': 'edit', 'label': 'Edit file'}, {'id': 'create', 'label': 'Open pull request', 'primary': True}]}
    return g_patch(t, seed_patch({'lastCard': last}))



# ---- Room setup --------------------------------------------------------------------------------------------------------
# Setup is taller than the window once these cards are on it, so the two pages are drawn with the page scrolled to its end.

def step_row(title, detail, meta='', needs=False, first=False):
    icon = ico(I_ASK, 15, '#f2c55c', '1.4') if needs else ico(I_CHECK, 15, '#4cb782', '1.8')
    meta_html = ('<span style="font-size: 12px; color: #f2c55c">%s</span>' % meta) if needs else ('<span style="font-family: %s; font-size: 12px; color: #8a8f98">%s</span>' % (MONO, meta))
    return ('<div style="display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border-top: %s"><div style="display: flex; align-items: center; gap: 12px">%s'
            '<span style="flex: 1; display: flex; flex-direction: column"><span style="font-weight: 500">%s</span><span style="font-size: 12.5px; color: #8a8f98">%s</span></span>%s</div></div>'
            % ('0' if first else '1px solid #1a1b1e', icon, title, detail, meta_html))


def steps_card(rows):
    return '<div style="display: flex; flex-direction: column; border-radius: 12px; border: 1px solid #1f2024; background: #0f1011">' + ''.join(rows) + '</div>'


def card(title, sub, body, label='rs-card'):
    return ('<section aria-labelledby="%s" style="display: flex; flex-direction: column; border-radius: 12px; border: 1px solid #1f2024; background: #0f1011">'
            '<div style="display: flex; flex-direction: column; gap: 2px; padding: 14px 16px 12px"><h2 id="%s" style="margin: 0; font-size: 14px; font-weight: 500">%s</h2>'
            '<p style="margin: 0; font-size: 12.5px; line-height: 1.5; color: #8a8f98">%s</p></div>%s</section>') % (label, label, title, sub, body)


def setup_page(title, cards, foot, button, scroll):
    dots = ''.join('<span aria-hidden="true" style="width: 12px; height: 12px; border-radius: 50%%; background: %s"></span>' % c for c in ('#ff5f57', '#febc2e', '#28c840'))
    head = ('<div style="display: flex; flex-direction: column; gap: 6px"><h1 style="margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.4px">Setting up Shop</h1>'
            '<p style="margin: 0; color: #8a8f98">This takes a minute. Your team is ready when it finishes.</p></div>')
    bottom = ('<div style="display: flex; align-items: center; gap: 10px"><span style="flex: 1; font-size: 12.5px; color: #8a8f98">' + foot + '</span>'
              '<a href="WorkspaceLead.dc.html" style="display: inline-flex; align-items: center; height: 32px; padding: 0 14px; border-radius: 8px; background: #f7f8f8; color: #08090a; text-decoration: none; font-weight: 500">' + button + '</a></div>')
    body = ('<div style="width: 1440px; height: 900px; display: flex; flex-direction: column; ' + WINDOW + '">'
            '<div style="height: 42px; flex-shrink: 0; display: flex; align-items: center; gap: 8px; padding: 0 16px">' + dots + '</div>'
            '<main style="flex: 1; min-height: 0; display: flex; justify-content: center; padding-top: 14px; overflow: hidden"><div style="width: 560px; flex-shrink: 0; display: flex; flex-direction: column; gap: 20px; margin-top: -%dpx">'
            % scroll + head + cards + bottom + '</div></main></div>')
    return page(title, body)


DONE_STEPS = [step_row('Use your folder', '~/Projects/shop', first=True), step_row('Create the worktree folder', '~/kernel/worktrees/shop'), step_row('Install dependencies', 'pnpm install', '12s'),
              step_row('Copy local files', '.env.local, .env.test'), step_row('Install hooks', '10 events to localhost:7420')]


def pick_row(label, desc, value):
    return ('<div style="display: flex; align-items: center; gap: 16px; padding: 12px 16px; border-top: 1px solid #1a1b1e"><span style="flex: 1; display: flex; flex-direction: column"><span style="font-weight: 500">%s</span>'
            '<span style="font-size: 12.5px; color: #8a8f98">%s</span></span><button type="button" aria-haspopup="listbox" aria-label="%s" style="display: inline-flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px; '
            'border: 1px solid #23252a; border-radius: 7px; background: #18191a; color: #f7f8f8; font-family: inherit; font-size: 13px; cursor: pointer">%s'
            '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="#8a8f98" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4 5 6.5 7.5 4"></path></svg></button></div>') % (label, desc, label, value)


def warn_row(who, text, action=''):
    act = '<button type="button" style="%s">%s</button>' % (LINK, action) if action else ''
    return ('<div style="display: flex; align-items: flex-start; gap: 10px; padding: 12px 16px; border-top: 1px solid #1a1b1e; font-size: 12.5px; color: #d0d6e0">' + ico(I_WARN, 14, '#f2c55c', '1.4', 'margin-top: 2px')
            + '<span style="flex: 1"><span style="color: #f7f8f8">%s</span> %s</span>%s</div>' % (who + ':', text, act))


def your_team(warns):
    return card('Your team', 'This repo brought its own agents. Check who leads and who reviews. Settings, Agents changes it later.',
                pick_row('Lead', 'Plans with you and hands out tasks', 'Rowan, from Kernel') + pick_row('Reviewer', 'Reviews each pull request before it merges', 'Theo, from Kernel') + ''.join(warns), 'rs-team')


def agent_pick(name, role, desc, on, tags=(), warn=''):
    w = ('<span style="display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 12px; color: #d0d6e0">' + ico(I_WARN, 12, '#f2c55c') + warn + '</span>') if warn else ''
    return ('<div role="checkbox" aria-checked="%s" style="display: flex; align-items: flex-start; gap: 12px; padding: 10px 16px; border-top: 1px solid #1a1b1e">%s'
            '<span style="flex: 1; min-width: 0; display: flex; flex-direction: column"><span style="display: flex; align-items: center; gap: 8px"><span style="font-weight: 500">%s</span>'
            '<span style="font-size: 12px; color: #8a8f98">%s</span>%s</span><span style="font-size: 12.5px; color: #8a8f98; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">%s</span>%s</span></div>'
            ) % ('true' if on else 'false', checkbox(on).replace('flex-shrink: 0;', 'flex-shrink: 0; margin-top: 2px;'), name, role, ''.join(pill(t) for t in tags), desc, w)


def room_setup_roster():
    rows = [
        agent_pick('Api', 'Backend', 'Builds the API and its migrations, then opens a pull request.', True),
        agent_pick('Architect', 'Architect', 'Designs the system and writes the plan. Writes no code.', False, ['Helper'], 'Written as a subagent with no pull request workflow, so it starts as a helper.'),
        agent_pick('Backend', 'Backend', 'Server code, queues and background jobs.', True),
        agent_pick('Debugger', 'Debugging', 'Reproduces a bug, finds the cause and fixes it.', True),
        agent_pick('Designer', 'Designer', 'Checks every screen against DESIGN.md before review.', True),
        agent_pick('Devops', 'Infrastructure', 'CI, deploys and environment setup.', True),
        agent_pick('Docs', 'Writer', 'Keeps the README and the docs folder current.', False, ['Personal']),
        agent_pick('Frontend', 'Frontend', 'UI work from an approved plan. Follows DESIGN.md.', True),
    ]
    search = ('<div style="display: flex; align-items: center; gap: 8px; padding: 0 16px 12px"><div style="flex: 1; display: flex; align-items: center; gap: 8px; height: 32px; box-sizing: border-box; padding: 0 10px; '
              'border-radius: 8px; border: 1px solid #23252a; background: #0b0c0d; color: #8a8f98">' + ico(I_SEARCH, 14) + '<span style="font-size: 13px">Search 23 agents</span></div></div>')
    listing = '<div role="group" aria-label="Agents" style="height: 346px; overflow: hidden">' + ''.join(rows) + '</div>'
    foot = ('<div style="display: flex; align-items: center; gap: 14px; padding: 11px 16px; border-top: 1px solid #1a1b1e; font-size: 12.5px; color: #8a8f98"><span style="flex: 1">8 of 23 picked</span>'
            '<button type="button" style="' + LINK + '">Clear</button><button type="button" style="' + LINK + '">Pick the suggested 8</button></div>')
    roster = card('Pick your team', 'This repo has 23 agents. Rowan hands tasks only to the ones you pick, so a long list doesn\u2019t crowd every plan. Kernel picked the 8 that can open pull requests.',
                  search + listing + foot, 'rs-roster')
    steps = steps_card(DONE_STEPS + [step_row('Seat agents', '23 agents found in .claude/agents and ~/.claude/agents', 'Needs you', needs=True)])
    return setup_page('Room setup, pick the roster', steps + roster, 'Pick who joins to finish. Rowan is waiting.', 'Seat 8 agents', 262)


def conflict_row(quote, ref, tells):
    return ('<div style="display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; padding: 12px 16px; border-top: 1px solid #1a1b1e">'
            '<div style="display: flex; flex-direction: column; gap: 6px"><span style="color: #f7f8f8; line-height: 1.5">\u201c%s\u201d</span>'
            '<a href="#" style="font-family: %s; font-size: 11.5px; color: #8a8f98">%s</a></div><span style="color: #d0d6e0; line-height: 1.5">%s</span></div>') % (quote, MONO, ref, tells)


def room_setup_conflicts():
    head = ('<div style="display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; padding: 8px 16px; border-top: 1px solid #1a1b1e; font-size: 12px; font-weight: 500; color: #8a8f98">'
            '<span>Your repo says</span><span>Kernel tells agents</span></div>')
    rows = [
        conflict_row('Commit straight to main. Skip the PR for small changes.', 'CLAUDE.md:14', 'Work on your own branch and open a pull request.'),
        conflict_row('Never open pull requests. Push to the shared branch when tests pass.', 'AGENTS.md:6', 'Every task ends in a pull request. Never push to a shared branch.'),
        conflict_row('Stack PRs: each branch builds on the one before it.', 'CLAUDE.md:22', 'Start from origin/main. One task, one branch, one pull request.'),
    ]
    conflicts = card('Rules in your repo that fight Kernel', 'Agents read these files too, so they may follow either. Kernel never edits them.', head + ''.join(rows), 'rs-conflicts')
    warns = [warn_row('Architect', 'its tools can\u2019t edit files and run git, so it doesn\u2019t take tasks.'), warn_row('Kai', 'Linear isn\u2019t signed in.', 'Sign in')]
    steps = steps_card(DONE_STEPS + [step_row('Seat agents', 'Api, Architect, Kai, Web from .claude/agents, Rowan and Theo from Kernel')])
    return setup_page('Room setup, repo rules', steps + your_team(warns) + conflicts, 'Done. Rowan is waiting for a brief.', 'Open the room', 492)


def build(emit, rd, ws, gsub, g_patch):
    emit('TeamWarnings', team_warnings(), None)
    emit('TeamPersonal', team_personal(), None)
    emit('AgentProfileServers', agent_profile_servers(), None)
    emit('AgentProfileScope', agent_profile_scope(), None)
    emit('ConfirmRetireScope', confirm_retire_scope(), None)
    emit('NewAgentDraftScope', new_agent_draft_scope(), None)
    emit('WorkspaceToolsGate', tools_gate(ws, gsub, g_patch), 'ws')
    emit('WorkspaceHireServers', hire_servers(ws, gsub, g_patch), 'lead')
    emit('RoomSetupRoster', room_setup_roster(), None)
    emit('RoomSetupConflicts', room_setup_conflicts(), None)
