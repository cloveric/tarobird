import { expect, it } from 'vitest';
import { mergeNetworkInviteRoute } from '../client/src/network-routes.js';
it('opening a LAN invite preserves existing Tailscale and VPS access',()=>{
 const ts={name:'Tailscale' as const,url:'https://100.80.1.2:8788'}, vps={name:'VPS' as const,url:'https://relay.test'};
 expect(mergeNetworkInviteRoute([ts,vps],{name:'Direct',url:'https://192.168.1.3:8788'})).toEqual([ts,vps]);
});
it('new Tailscale replaces LAN without discarding relay fallback or duplicating it',()=>{
 const ts={name:'Tailscale' as const,url:'https://100.80.1.2:8788'}, vps={name:'VPS' as const,url:'https://relay.test'};
 expect(mergeNetworkInviteRoute([{name:'Direct',url:'https://192.168.1.3:8788'},vps],ts)).toEqual([ts,vps]);
 expect(mergeNetworkInviteRoute([ts,vps],ts)).toEqual([ts,vps]);
});

it('sharing a current VPS route preserves existing direct and fallback routes',()=>{
 const ts={name:'Tailscale' as const,url:'https://100.80.1.2:8788'}, a={name:'VPS' as const,url:'https://relay-a.test'}, b={name:'VPS' as const,url:'https://relay-b.test'};
 expect(mergeNetworkInviteRoute([ts,a],b)).toEqual([ts,a,b]);
 expect(mergeNetworkInviteRoute([ts,a,b],b)).toEqual([ts,a,b]);
});

it('explicit network correction can replace Tailscale with LAN while preserving VPS',()=>{
 const ts={name:'Tailscale' as const,url:'https://100.80.1.2:8788'}, vps={name:'VPS' as const,url:'https://relay.test'}, lan={name:'Direct' as const,url:'https://192.168.1.3:8788'};
 expect(mergeNetworkInviteRoute([ts,vps],lan,true)).toEqual([lan,vps]);
});
