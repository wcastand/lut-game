'use strict';
(() => {
  function dayKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  }
  function validDay(key) {
    if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
    const [year,month,day] = key.split('-').map(Number);
    if (year < 1000) return false;
    const date = new Date(Date.UTC(year,month-1,day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month-1 && date.getUTCDate() === day;
  }
  function dateForKey(key) {
    const [year,month,day] = key.split('-').map(Number);
    return new Date(year,month-1,day);
  }
  function ordinal(key) {
    const [year,month,day] = key.split('-').map(Number);
    return Math.floor(Date.UTC(year,month-1,day)/86400000);
  }
  function movieForDay(movies,key) {
    const schedule = [...movies];
    let seed = 718293;
    for (let i = schedule.length-1;i > 0;i--) {
      seed = (Math.imul(seed,1664525)+1013904223) >>> 0;
      const j = Math.floor(seed/4294967296*(i+1));
      [schedule[i],schedule[j]] = [schedule[j],schedule[i]];
    }
    return schedule[((ordinal(key)%schedule.length)+schedule.length)%schedule.length];
  }
  function shareId(movie) {
    let a = 2166136261;
    let b = 2246822519;
    for (const color of movie.colors) for (const char of color) {
      a = Math.imul(a^char.charCodeAt(0),16777619) >>> 0;
      b = Math.imul(b^char.charCodeAt(0),3266489917) >>> 0;
    }
    return a.toString(16).padStart(8,'0')+b.toString(16).padStart(8,'0');
  }
  function recentDayForMovie(movies,movie,today) {
    for (let offset = 0;offset < movies.length;offset++) {
      const key = new Date((ordinal(today)-offset)*86400000).toISOString().slice(0,10);
      if (movieForDay(movies,key).id === movie.id) return key;
    }
  }
  window.LUT_DAILY = Object.freeze({dayKey,validDay,dateForKey,movieForDay,shareId,recentDayForMovie});
})();
