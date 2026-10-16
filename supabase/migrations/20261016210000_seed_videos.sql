-- The suggested repair videos become ordinary rows, so they can be removed like any other.
insert into public.videos (topic, title, url, created_by)
select v.topic, v.title, v.url, 'sugerido'
from (values
  ('Bomba auxiliar de gasolina', 'Fiat Panda 4x4 965cc: de bomba de gasolina mecánica a eléctrica (italiano)', 'https://www.youtube.com/watch?v=SjIQ-gRZx_Y'),
  ('Bomba auxiliar de gasolina', 'Tutorial bomba de gasolina Fiat Panda 900, 1000 y 1100 (italiano)', 'https://www.youtube.com/watch?v=1LUxsJdsd9c'),
  ('Bomba auxiliar de gasolina', 'Relé de la bomba de combustible de la Panda (italiano)', 'https://www.youtube.com/watch?v=D1DE0mRe71E'),
  ('Bomba auxiliar de gasolina', 'Cómo instalar una bomba eléctrica en serie en un coche de carburador (español)', 'https://www.youtube.com/watch?v=67BTxRSmgzI'),
  ('Bomba auxiliar de gasolina', 'Instalación de una bomba de gasolina universal Airtex (español)', 'https://www.youtube.com/watch?v=DMny0myBQOA'),
  ('Alternador', 'Sustitución del alternador en Fiat (italiano)', 'https://www.youtube.com/watch?v=92DigGR3I0s'),
  ('Alternador', 'Mantenimiento y montaje del alternador de la Fiat Panda 4x4 Trekking (italiano)', 'https://www.youtube.com/watch?v=1Lb3Gpdqd3s'),
  ('Alternador', 'Alternador Fiat, Lancia, Alfa Romeo: desmontaje fácil (italiano)', 'https://www.youtube.com/watch?v=6aNGrrVZqCw'),
  ('Alternador', 'La batería no carga: reparación del alternador de la Fiat Panda 169 (italiano)', 'https://www.youtube.com/watch?v=CMNIL6jXzy8')
) as v(topic, title, url)
where not exists (select 1 from public.videos x where x.url = v.url);
