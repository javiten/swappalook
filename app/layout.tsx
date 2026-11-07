import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import './globals.css'
export const metadata: Metadata = { title: 'SwappaLook · Intercambios de belleza', description: 'Red privada para intercambiar servicios de belleza.' }
export const viewport: Viewport = { colorScheme: 'light', themeColor: '#fbf8f5', width: 'device-width', initialScale: 1, userScalable: false }
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="es"><body className="antialiased">{children}{process.env.NODE_ENV === 'production' && <Analytics />}</body></html> }
