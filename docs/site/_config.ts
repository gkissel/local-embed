import lume from 'https://deno.land/x/lume@v3.2.5/mod.ts';

const site = lume({
  src: '.',
  dest: './_site',
  location: new URL('https://localembed.dev'),
});

site.ignore('README.md');
site.copy('assets');
site.copy('contracts');
site.copy('llms.txt');

export default site;
