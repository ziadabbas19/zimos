'use strict';

const { parseVideoSource, videoUrlRule } = require('../../src/modules/pages/videoEmbed');
const { validatePageTree } = require('../../src/modules/pages/pageTree');
const { ValidationError } = require('../../src/core/errors/AppError');

const treeWith = (props) => ({
  version: 1,
  sections: [
    {
      id: 's1',
      type: 'section',
      rows: [{ id: 'r1', type: 'row', columns: [{ id: 'c1', type: 'column', span: 12, elements: [{ id: 'e1', type: 'video', props }] }] }],
    },
  ],
});

describe('video addresses', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=42', 'youtube', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'youtube', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    ['youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    ['https://vimeo.com/123456789', 'vimeo', 'https://player.vimeo.com/video/123456789'],
    ['https://vimeo.com/123456789/abcdef1234', 'vimeo', 'https://player.vimeo.com/video/123456789?h=abcdef1234'],
    ['https://www.facebook.com/watch/?v=1234567890', 'facebook', 'https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fwatch%2F%3Fv%3D1234567890&show_text=false'],
    ['https://www.facebook.com/zimos/videos/1234567890/', 'facebook', 'https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fzimos%2Fvideos%2F1234567890%2F&show_text=false'],
    ['https://www.instagram.com/reel/Cabc12345/', 'instagram', 'https://www.instagram.com/reel/Cabc12345/embed/'],
    ['https://www.tiktok.com/@shop/video/7234567890123456789', 'tiktok', 'https://www.tiktok.com/player/v1/7234567890123456789'],
    ['https://zimos.wistia.com/medias/abc123def4', 'wistia', 'https://fast.wistia.net/embed/iframe/abc123def4'],
    ['https://www.loom.com/share/0123456789abcdef0123456789abcdef', 'loom', 'https://www.loom.com/embed/0123456789abcdef0123456789abcdef'],
    ['https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing', 'drive', 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/preview'],
  ])('reads %s', (input, provider, src) => {
    const parsed = parseVideoSource(input);
    expect(parsed).toMatchObject({ ok: true, kind: 'iframe', provider, src });
    // What is stored reads the same the next time it is saved or drawn.
    expect(parseVideoSource(parsed.src)).toMatchObject({ ok: true, provider, src });
  });

  it('takes a direct video file from any https address, and from the store itself', () => {
    expect(parseVideoSource('https://cdn.example.com/clips/film.mp4')).toMatchObject({ ok: true, kind: 'file', src: 'https://cdn.example.com/clips/film.mp4' });
    expect(parseVideoSource('http://cdn.example.com/film.mp4')).toMatchObject({ ok: true, kind: 'file', src: 'https://cdn.example.com/film.mp4' });
    expect(parseVideoSource('/media/film.webm')).toMatchObject({ ok: true, kind: 'file', src: '/media/film.webm' });
  });

  it('reads only the address out of pasted iframe code', () => {
    const parsed = parseVideoSource(
      '<iframe width="560" height="315" src="https://www.youtube.com/embed/dQw4w9WgXcQ?si=abc&amp;x=1" title="x" onload="alert(1)" srcdoc="hello" allowfullscreen></iframe>'
    );
    expect(parsed).toEqual({ ok: true, kind: 'iframe', provider: 'youtube', src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', id: 'dQw4w9WgXcQ' });
  });

  it.each([
    ['<script>alert(1)</script>'],
    ['<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" srcdoc="<script>alert(1)</script>"></iframe>'],
    ['<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe><script src="https://evil.example/x.js"></script>'],
    ['< script >alert(1)</script>'],
    ['<img src=x onerror=alert(1)>'],
    ['<svg onload=alert(1)>'],
    ['javascript:alert(1)'],
    ['JaVaScRiPt:alert(1)'],
    ['java\nscript:alert(1)'],
    ['&#106;avascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['<iframe src="javascript:alert(1)"></iframe>'],
    ['<iframe src="&#106;avascript:alert(1)"></iframe>'],
    ['<iframe src="data:text/html;base64,PHNjcmlwdD4="></iframe>'],
    ['https://www.youtube.com@evil.example/embed/dQw4w9WgXcQ'],
  ])('refuses %s', (input) => {
    expect(parseVideoSource(input)).toEqual({ ok: false, problem: 'unsafe' });
  });

  it.each([
    ['https://evil.example/embed/video'],
    ['https://youtube.com.evil.example/embed/dQw4w9WgXcQ'],
    ['https://evil.example/youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://notyoutube.com/watch?v=dQw4w9WgXcQ'],
    ['https://www.youtube.com:8443.evil.example/embed/dQw4w9WgXcQ'],
    ['https://www.youtube.com:8443/embed/dQw4w9WgXcQ'],
    ['<iframe src="https://evil.example/player"></iframe>'],
    ['/about'],
  ])('refuses the unknown host in %s', (input) => {
    const parsed = parseVideoSource(input);
    expect(parsed.ok).toBe(false);
    expect(['unknown-host', 'unreadable']).toContain(parsed.problem);
  });

  it('asks for the full address of a short TikTok link', () => {
    expect(parseVideoSource('https://vm.tiktok.com/ZMabc123/')).toEqual({ ok: false, problem: 'short-link' });
  });

  it('never loads a Facebook plugin address that points elsewhere', () => {
    const inner = encodeURIComponent('https://evil.example/videos/123456');
    expect(parseVideoSource(`https://www.facebook.com/plugins/video.php?href=${inner}`).ok).toBe(false);
  });
});

describe('the video element in a page', () => {
  const refused = (props) => {
    try {
      validatePageTree(treeWith(props));
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      return true;
    }
    return false;
  };

  it('saves a known address with its options, and an element with no address yet', () => {
    expect(refused({ url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', aspect: '9:16', maxWidth: 'full', rounded: false, autoplay: false, title: 'Our story', caption: 'Made here' })).toBe(false);
    expect(refused({ url: '', title: '' })).toBe(false);
  });

  it.each([
    [{ url: 'https://evil.example/player' }],
    [{ url: 'javascript:alert(1)' }],
    [{ url: '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>' }],
    [{ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', aspect: '2:1' }],
    [{ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', maxWidth: 'huge' }],
    [{ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: '<b>x</b>' }],
    [{ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', caption: '<img src=x onerror=alert(1)>' }],
    [{ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', autoplay: 'yes' }],
  ])('refuses %j', (props) => {
    expect(refused(props)).toBe(true);
  });

  it('tells the merchant what went wrong in both languages', () => {
    expect(videoUrlRule('https://evil.example/player')).toMatch(/YouTube.*يوتيوب/);
  });
});
