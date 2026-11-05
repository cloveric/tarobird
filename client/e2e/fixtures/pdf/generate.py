# Test fixtures only. Requires reportlab and pypdf with cryptography.
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from pypdf import PdfReader,PdfWriter
out=Path(__file__).parent
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
p=out/'reading.pdf'
c=canvas.Canvas(str(p),pagesize=(480,640),invariant=True,pageCompression=0)
for n,color in [(1,(.72,.27,.12)),(2,(.08,.43,.58))]:
 c.setFillColorRGB(.99,.98,.95);c.rect(0,0,480,640,fill=1,stroke=0)
 c.setFillColorRGB(*color);c.rect(32,526,416,72,fill=1,stroke=0)
 c.setFillColorRGB(1,1,1);c.setFont('Helvetica-Bold',22);c.drawString(48,552,f'TaroCub / Page {n}')
 c.setFillColorRGB(.15,.15,.15);c.setFont('Helvetica',14);c.drawString(32,476,f'PAGE_{n}_CONTENT')
 c.setFont('STSong-Light',16);c.drawString(32,432,'阅读空间：预览、翻页与文字选择')
 c.setFont('Helvetica',12);c.drawString(32,382,'A quiet reading space, across your devices.')
 c.drawString(32,350,'This document contains only synthetic test content.')
 for i in range(5):
  c.setStrokeColorRGB(.78,.76,.72);c.line(32,298-i*36,448,298-i*36)
  c.setFillColorRGB(.23,.23,.23);c.drawString(40,278-i*36,f'Note {i+1} / Page {n}')
 c.showPage()
c.save()
w=PdfWriter();w.append(str(p));w.encrypt('reading-acceptance',algorithm='AES-256');w.write(str(out/'locked.pdf'))
# A valid PDF may contain actions. The reader must neither execute them nor
# follow annotation links automatically.
w=PdfWriter();w.append(str(p));w.add_js("this.submitForm({cURL:'https://pdf-preview.invalid/never-send'});");w.write(str(out/'actions.pdf'))
(out/'broken.pdf').write_bytes(b'%PDF-1.7\nnot a valid document')
print('Created four synthetic fixtures')
