// src/components/MagicNumberForm.jsx
import React, { useState } from 'react';
import { useRouter } from 'next/router';

const MagicNumberForm = () => {
    const [magicNumber, setMagicNumber] = useState('');
    const router = useRouter();

    const handleSubmit = (event) => {
        event.preventDefault();
        // Check if the entered magic number is correct
        if (magicNumber === process.env.NEXT_PUBLIC_MAGIC_NUMBER) {
            // Set a flag in local storage or a session
            localStorage.setItem('isSupervisor', 'true');
            // Redirect to the dashboard
            router.push('/dashboard');
        } else {
            alert('Incorrect magic number!');
            setMagicNumber('');
        }
    };

    return (
        <form onSubmit={handleSubmit}>
            <label htmlFor="magicNumber">Enter Magic Number:</label>
            <input
                type="password"
                id="magicNumber"
                value={magicNumber}
                onChange={(e) => setMagicNumber(e.target.value)}
            />
            <button type="submit">Access Dashboard</button>
        </form>
    );
};

export default MagicNumberForm;
