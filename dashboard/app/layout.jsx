import "./styles.css";

export const metadata = {
  title: "Extension Dashboard",
  description: "License dashboard and API for the Lovable extension",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
