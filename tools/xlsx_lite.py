"""A tiny .xlsx writer on the standard library (no openpyxl needed by the scheduled task).

write_xlsx(path, sheets) where a sheet is
    {'name': str, 'columns': [(title, width, kind)], 'rows': [[value, ...]],
     'table': True}   # table: bold header, frozen first row, autofilter
kind: 'text' | 'int' | 'datetime' | 'wrap' (text that wraps) | 'label' (bold text).
A value can be None, str, int/float, datetime, or {'f': 'COUNTA(...)', 'v': cached} for a formula
(Excel recalculates formulas on open; the cached value is what previews show). Wrap any of them as
{'kind': 'datetime', 'value': ...} (or add 'kind' to a formula dict) to format one cell differently.
"""

import datetime
import re
import zipfile
from xml.sax.saxutils import escape

EPOCH = datetime.datetime(1899, 12, 30)
STYLE = {'text': 0, 'header': 1, 'datetime': 2, 'int': 3, 'wrap': 4, 'label': 5}
BAD_XML = re.compile('[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]')

STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy hh:mm"/></numFmts>
<fonts count="2"><font><sz val="10"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="10"/><name val="Arial"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEDEDED"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>"""


def col_letter(i):
    s = ''
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def text(v):
    return escape(BAD_XML.sub('', str(v)))


def serial(dt):
    return (dt - EPOCH).total_seconds() / 86400


def cell(ref, value, style):
    s = f' s="{style}"' if style else ''
    if value is None or value == '':
        return f'<c r="{ref}"{s}/>' if style else ''
    if isinstance(value, dict):  # formula with a cached value
        v = value.get('v')
        if isinstance(v, str):
            return f'<c r="{ref}"{s} t="str"><f>{text(value["f"])}</f><v>{text(v)}</v></c>'
        cached = '' if v is None else f'<v>{v}</v>'
        return f'<c r="{ref}"{s}><f>{text(value["f"])}</f>{cached}</c>'
    if isinstance(value, datetime.datetime):
        return f'<c r="{ref}"{s}><v>{serial(value):.8f}</v></c>'
    if isinstance(value, bool):
        value = int(value)
    if isinstance(value, (int, float)):
        return f'<c r="{ref}"{s}><v>{value}</v></c>'
    return f'<c r="{ref}"{s} t="inlineStr"><is><t xml:space="preserve">{text(value)}</t></is></c>'


def sheet_xml(sh, selected=False):
    cols, rows, table = sh['columns'], sh['rows'], sh.get('table', True)
    last_col = col_letter(len(cols) - 1)
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
           '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
           'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">']
    sel = ' tabSelected="1"' if selected else ''
    if table:
        out.append(f'<sheetViews><sheetView{sel} workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
                   '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>')
    else:
        out.append(f'<sheetViews><sheetView{sel} workbookViewId="0"/></sheetViews>')
    out.append('<sheetFormatPr defaultRowHeight="13.5"/><cols>')
    for i, (_, width, _) in enumerate(cols):
        out.append(f'<col min="{i + 1}" max="{i + 1}" width="{width}" customWidth="1"/>')
    out.append('</cols><sheetData>')
    body = ([[t for t, _, _ in cols]] if table else []) + rows
    for r, row in enumerate(body, 1):
        cells = []
        for c, value in enumerate(row):
            kind = cols[c][2] if c < len(cols) else 'text'
            if isinstance(value, dict) and 'kind' in value:  # per-cell format: {'kind', 'value'} or {'kind', 'f', 'v'}
                kind = value['kind']
                value = value['value'] if 'value' in value else {k: v for k, v in value.items() if k != 'kind'}
            style = STYLE['header'] if table and r == 1 else STYLE.get(kind, 0)
            cells.append(cell(f'{col_letter(c)}{r}', value, style))
        out.append(f'<row r="{r}">{"".join(cells)}</row>')
    out.append('</sheetData>')
    if table:
        out.append(f'<autoFilter ref="A1:{last_col}{max(1, len(body))}"/>')
    out.append('<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>')
    return ''.join(out)


def write_xlsx(path, sheets, active=0):
    """active: index of the sheet the file opens on."""
    sheet_tags, rels, overrides, names = [], [], [], []
    for i, sh in enumerate(sheets, 1):
        sheet_tags.append(f'<sheet name="{text(sh["name"])}" sheetId="{i}" r:id="rId{i}"/>')
        rels.append(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>')
        overrides.append(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
        if sh.get('table', True):
            last = col_letter(len(sh['columns']) - 1)
            n = max(1, len(sh['rows']) + 1)
            names.append(f'<definedName name="_xlnm._FilterDatabase" localSheetId="{i - 1}" hidden="1">\'{text(sh["name"])}\'!$A$1:${last}${n}</definedName>')
    n_styles = len(sheets) + 1
    workbook = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                f'<bookViews><workbookView activeTab="{active}"/></bookViews>'
                f'<sheets>{"".join(sheet_tags)}</sheets>'
                + (f'<definedNames>{"".join(names)}</definedNames>' if names else '')
                + '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>')
    wb_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               + ''.join(rels)
               + f'<Relationship Id="rId{n_styles}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
               '</Relationships>')
    content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                     '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     '<Default Extension="xml" ContentType="application/xml"/>'
                     '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                     '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                     + ''.join(overrides) + '</Types>')
    root_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                 '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                 '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
                 '</Relationships>')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', content_types)
        z.writestr('_rels/.rels', root_rels)
        z.writestr('xl/workbook.xml', workbook)
        z.writestr('xl/_rels/workbook.xml.rels', wb_rels)
        z.writestr('xl/styles.xml', STYLES)
        for i, sh in enumerate(sheets, 1):
            z.writestr(f'xl/worksheets/sheet{i}.xml', sheet_xml(sh, i - 1 == active))
